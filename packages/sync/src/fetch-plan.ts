// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Where each chunk comes from (docs/architecture.md#choosing-where-each-chunk-comes-from). A link
// takes requests only while it has room, so no link holds a film's worth queued.
//
// A burst of events plans once, in a microtask, and a pass skips whole ranges of chunks that are
// held, coming live or advertised by no one, so its work follows what changed, not the film's
// length.

import { chunkKey, type ChunkSlot } from "./chunk";
import { chunkAt, type JoinedIndex } from "./chunk-index";
import type { KeyId } from "./crypto";
import { SOURCE_ROOM } from "./push-queue";

/** How soon an interest needs its chunks, most first. */
export type FetchPriority = "urgent" | "ahead" | "background";

/** What an interest covers, its tracks resolved to ids. */
export type Want = { tracks: number[]; fromUs: number; toUs: number; priority: FetchPriority };

export type Fetch = { slot: ChunkSlot; peer: KeyId; priority: FetchPriority };

export type LinkMeasures = { rttMs: number; bytesPerMs: number };

export type FetchPlanOptions = {
  source: KeyId;
  index(): JoinedIndex;
  /** Whether every chunk is listed, so a moment past the last is covered by it. */
  ended(): boolean;
  /** What a chunk of a track costs against the video's: its bitrate over the video's. */
  ratio(track: number): number;
  /** The first index at or after `from` this peer neither holds nor will get live. */
  missing(track: number, from: number): number;
  /** The first index at or after `from` a connected forwarder advertises, if any. */
  advertised(track: number, from: number): number | undefined;
  /** The forwarders whose newest ranges hold a chunk. */
  holders(slot: ChunkSlot): KeyId[];
  /** The links open now, the source's among them while it is online, with their measures. */
  links(): ReadonlyMap<KeyId, LinkMeasures>;
  /** The time, in milliseconds, on the clock that playhead updates are given in. */
  now(): number;
  ask(fetch: Fetch): void;
  cancel(fetch: Fetch): void;
};

type Request = Fetch & { bytes: number; arrived: number; started: boolean };

type Span = [number, number];

const RANK: Record<FetchPriority, number> = { urgent: 0, ahead: 1, background: 2 };
const PRIORITIES: FetchPriority[] = ["urgent", "ahead", "background"];
// Requests a link may have out whatever its throughput: one chunk arriving and the next already
// asked, so the link never waits a round trip between them.
const LINK_DEPTH = 2;

const remaining = (request: Request) => Math.max(0, request.bytes - request.arrived);

// The index span `[first, end)` an interest covers, or undefined while none of it is listed.
function spanOf(want: Want, bounds: number[], ended: boolean): Span | undefined {
  const first = chunkAt(bounds, want.fromUs, ended);
  if (first === undefined) return undefined;
  const last = chunkAt(bounds, Math.max(want.fromUs, want.toUs - 1), ended) ?? bounds.length - 2;
  return [first, last + 1];
}

// The first index at or after `from` and before `limit` that is in `spans` and that `skip`
// leaves where it is; `skip` moves an index on past what isn't wanted, whole ranges at a time.
function nextIn(spans: Span[], from: number, limit: number, skip: (index: number) => number) {
  for (let at = from; at < limit;) {
    const span = spans.find(([, end]) => end > at);
    if (span === undefined) return undefined;
    const into = Math.max(at, span[0]);
    const next = skip(into);
    if (next <= into) return into < limit ? into : undefined;
    at = next;
  }

  return undefined;
}

// The chunks the spans of each track cover, through `next`, in start order from the playhead to
// the end, then from the start to the playhead.
function* ordered(
  byTrack: Map<number, Span[]>,
  playhead: number,
  next: (track: number, spans: Span[], from: number, limit: number) => number | undefined,
) {
  for (const [from, limit] of [
    [playhead, Infinity],
    [0, playhead],
  ] as const) {
    // copy: one cursor per track, moved as its chunks are taken.
    const cursors = [...byTrack].map(([track, spans]) => ({
      track,
      spans,
      at: next(track, spans, from, limit),
    }));

    for (;;) {
      const cursor = cursors
        .filter((c) => c.at !== undefined)
        .reduce<(typeof cursors)[number] | undefined>(
          (a, c) => (a && a.at! <= c.at! ? a : c),
          undefined,
        );
      if (cursor === undefined) break;
      yield { track: cursor.track, index: cursor.at! };
      cursor.at = next(cursor.track, cursor.spans, cursor.at! + 1, limit);
    }
  }
}

// The chunk index as last read, kept until a new page arrives: joining it copies every page.
function createListing(options: FetchPlanOptions) {
  const state: { held?: { index: JoinedIndex; ended: boolean } } = {};

  function read() {
    state.held ??= { index: options.index(), ended: options.ended() };
    return state.held;
  }

  return { read, drop: () => delete state.held };
}

type Listing = ReturnType<typeof createListing>;

// The interests stated, each with the index span it covers as of the last pass.
function createWants(listing: Listing, changed: () => void) {
  const wants = new Set<{ want: Want; span: Span | undefined }>();

  function want(interest: Want) {
    // copy: the interest's own range, which `move` changes and the caller's object doesn't.
    const held = { want: { ...interest }, span: undefined as Span | undefined };
    wants.add(held);
    changed();

    return {
      /** Moves the interest to a new range; a range that covers the same chunks plans nothing. */
      move(fromUs: number, toUs: number) {
        held.want.fromUs = fromUs;
        held.want.toUs = toUs;
        const { index, ended } = listing.read();
        const span = spanOf(held.want, index.bounds, ended);
        if (span?.[0] !== held.span?.[0] || span?.[1] !== held.span?.[1]) changed();
      },
      /** Ends the interest: what only it covered is asked for no more. */
      release() {
        wants.delete(held);
        changed();
      },
    };
  }

  function refresh(bounds: number[], ended: boolean) {
    for (const held of wants) held.span = spanOf(held.want, bounds, ended);
  }

  // The highest priority an interest covers a chunk at, or undefined if none does.
  function priorityOf({ track, index }: ChunkSlot) {
    const covering = wants
      .values()
      .filter(
        (held) =>
          held.span &&
          held.span[0] <= index &&
          index < held.span[1] &&
          held.want.tracks.includes(track),
      )
      .map((held) => held.want.priority);
    return covering.reduce<FetchPriority | undefined>(
      (a, p) => (a && RANK[a] <= RANK[p] ? a : p),
      undefined,
    );
  }

  function spans(priority: FetchPriority) {
    const byTrack = new Map<number, Span[]>();

    for (const { want: interest, span } of wants) {
      if (span === undefined || interest.priority !== priority) continue;

      for (const track of interest.tracks) {
        const list = byTrack.get(track) ?? [];
        list.push(span);
        byTrack.set(track, list);
      }
    }

    // Sorted in place: each list is this pass's own.
    for (const list of byTrack.values()) list.sort((a, b) => a[0] - b[0]);
    return byTrack;
  }

  return { want, refresh, priorityOf, spans };
}

// The requests out, one per chunk, and the peers that answered `gone` for each chunk.
function createRequests(options: FetchPlanOptions) {
  const out = new Map<string, Request>();
  const refused = new Map<string, Set<KeyId>>();

  function ask(slot: ChunkSlot, peer: KeyId, priority: FetchPriority, bytes: number) {
    out.set(chunkKey(slot), { slot, peer, priority, bytes, arrived: 0, started: false });
    options.ask({ slot, peer, priority });
  }

  function cancel(key: string, { slot, peer, priority }: Request) {
    out.delete(key);
    options.cancel({ slot, peer, priority });
  }

  // Ends `peer`'s request for a chunk on its reply. Returns whether it was that peer's.
  function end(peer: KeyId, slot: ChunkSlot) {
    const key = chunkKey(slot);
    if (out.get(key)?.peer !== peer) return false;
    out.delete(key);
    return true;
  }

  function piece(slot: ChunkSlot, peer: KeyId, bytes: number) {
    const request = out.get(chunkKey(slot));
    if (request?.peer !== peer) return;
    request.started = true;
    request.arrived += bytes;
  }

  function refuse(slot: ChunkSlot, peer: KeyId) {
    const key = chunkKey(slot);
    refused.set(key, (refused.get(key) ?? new Set()).add(peer));
  }

  // Gives each request the priority its chunk is wanted at now: cancels those no interest
  // covers, and asks the same link again for one turned urgent, so its request moves up, unless
  // its chunk has begun to arrive and the rest is on its way.
  function settle(priorityOf: (slot: ChunkSlot) => FetchPriority | undefined) {
    for (const [key, request] of out) {
      const priority = priorityOf(request.slot);
      if (priority === undefined) cancel(key, request);
      else if (priority === "urgent" && request.priority !== "urgent" && !request.started) {
        request.priority = priority;
        options.ask({ slot: request.slot, peer: request.peer, priority });
      } else request.priority = priority;
    }
  }

  return {
    out,
    ask,
    cancel,
    end,
    piece,
    refuse,
    settle,
    refuses: (key: string, peer: KeyId) => refused.get(key)?.has(peer) === true,
    forget: (key: string) => refused.delete(key),
    /** Forgets what `peer` answered `gone` to: its ranges or capability record changed. */
    forgive(peer: KeyId) {
      for (const peers of refused.values()) peers.delete(peer);
    },
    /** Cancels every request that has sent nothing yet. */
    halt() {
      for (const [key, request] of out) if (!request.started) cancel(key, request);
    },
    /** Puts every request of a closed link back into the plan. */
    closed(peer: KeyId) {
      for (const [key, request] of out) if (request.peer === peer) out.delete(key);
    },
    /** Whether an urgent or ahead request is out, which holds background ones back. */
    pressing: () => out.values().some((r) => r.priority !== "background"),
  };
}

// Each link's room and the time it is expected to take, from its measures and its requests out.
function createRoom(options: FetchPlanOptions, out: Map<string, Request>) {
  // Links that answered `busy`, which gain no room until their next delivery is done.
  const blocked = new Set<KeyId>();

  // Whether a link takes another request: fewer than `LINK_DEPTH` out, or bytes out under
  // throughput × RTT. The source is never sent more than `SOURCE_ROOM`, past which it answers
  // `busy`.
  function room(peer: KeyId) {
    const measures = options.links().get(peer);
    if (measures === undefined || blocked.has(peer)) return false;
    const on = out.values().filter((r) => r.peer === peer);
    const [count, bytes] = on.reduce(([n, b], r) => [n + 1, b + remaining(r)], [0, 0]);
    if (peer === options.source && count >= SOURCE_ROOM) return false;
    return count < LINK_DEPTH || bytes < measures.bytesPerMs * measures.rttMs;
  }

  // The request an urgent chunk may take the place of on a full forwarder link: the newest
  // lower-priority one that has sent nothing.
  function victim(peer: KeyId) {
    const lower = out
      .entries()
      .filter(([, r]) => r.peer === peer && r.priority !== "urgent" && !r.started);
    return lower.reduce<[string, Request] | undefined>((_, entry) => entry, undefined);
  }

  // Milliseconds `peer` is expected to take to finish `own`: a round trip, then what is left of the
  // chunks already arriving and of earlier requests of the same or higher priority, then `own`'s
  // bytes yet to arrive. `own` counts as asked after every request out unless it is one of them.
  function finish(peer: KeyId, own: Request) {
    const { rttMs, bytesPerMs } = options.links().get(peer)!;
    let earlier = true;
    let queued = 0;

    for (const request of out.values()) {
      if (request === own) earlier = false;
      else if (request.peer !== peer) continue;
      else if (request.started || (earlier && RANK[request.priority] <= RANK[own.priority])) {
        queued += remaining(request);
      }
    }

    return rttMs + (queued + remaining(own)) / bytesPerMs;
  }

  // Whether a link takes a chunk at `priority`, an urgent one in place of a lower one.
  const takes = (peer: KeyId, priority: FetchPriority) =>
    room(peer) ||
    (priority === "urgent" &&
      peer !== options.source &&
      !blocked.has(peer) &&
      victim(peer) !== undefined);

  // Of `peers`, the one that takes a chunk at `priority` and is expected to finish it first.
  function fastest(peers: KeyId[], own: Request) {
    const taking = peers.filter((peer) => takes(peer, own.priority));
    const finishes = taking.map((peer) => ({ peer, ms: finish(peer, own) }));
    return finishes.reduce<(typeof finishes)[number] | undefined>(
      (a, f) => (a && a.ms <= f.ms ? a : f),
      undefined,
    )?.peer;
  }

  return {
    room,
    victim,
    finish,
    takes,
    fastest,
    block: (peer: KeyId) => blocked.add(peer),
    unblock: (peer: KeyId) => blocked.delete(peer),
  };
}

type Requests = ReturnType<typeof createRequests>;
type Room = ReturnType<typeof createRoom>;
type Wants = ReturnType<typeof createWants>;

// Places chunks on links that have room, by the docs' decision tree, in each priority's order.
function createPlacer(options: FetchPlanOptions, requests: Requests, room: Room, wants: Wants) {
  const forwarders = () =>
    options
      .links()
      .keys()
      .filter((peer) => peer !== options.source);

  function open(priority: FetchPriority) {
    const sourceTakes = priority !== "ahead" && room.room(options.source);
    return sourceTakes || forwarders().some((peer) => room.takes(peer, priority));
  }

  // Asks for a chunk as the decision tree says. Returns false when a link the tree allows for it
  // has no room, so the chunks after it wait their turn; true when it was asked, or left to wait.
  function place(slot: ChunkSlot, priority: FetchPriority, bytes: number) {
    const key = chunkKey(slot);
    const links = options.links();
    const own: Request = {
      slot,
      peer: options.source,
      priority,
      bytes,
      arrived: 0,
      started: false,
    };
    const holding = options
      .holders(slot)
      .filter((peer) => links.has(peer) && !requests.refuses(key, peer));

    if (holding.length > 0) {
      const peer = room.fastest(holding, own);
      if (peer === undefined) return false;
      const victim = room.room(peer) ? undefined : room.victim(peer);
      if (victim) requests.cancel(victim[0], victim[1]);
      requests.ask(slot, peer, priority, bytes);
      return true;
    }

    if (priority === "ahead" || requests.refuses(key, options.source)) return true;
    if (!room.room(options.source)) return false;
    requests.ask(slot, options.source, priority, bytes);
    return true;
  }

  // Places the chunks wanted at `priority`, in order, until one finds no room.
  function scan(priority: FetchPriority, index: JoinedIndex, playhead: number) {
    // Only a forwarder can bring a chunk ahead, or any chunk while the source is offline.
    const onlyAdvertised = priority === "ahead" || !options.links().has(options.source);

    const next = (track: number, spans: Span[], from: number, limit: number) =>
      nextIn(spans, from, limit, (at) => {
        const needed = options.missing(track, at);
        return onlyAdvertised
          ? Math.max(needed, options.advertised(track, needed) ?? Infinity)
          : needed;
      });

    for (const slot of ordered(wants.spans(priority), playhead, next)) {
      if (!open(priority)) return;
      if (requests.out.has(chunkKey(slot))) continue;
      const bytes = Math.ceil(index.bytes[slot.index]! * options.ratio(slot.track));
      if (!place(slot, priority, bytes)) return;
    }
  }

  return { scan };
}

// The playhead, the deadlines it gives the chunks ahead, and the urgent requests that would
// miss theirs.
function createClock(
  options: FetchPlanOptions,
  listing: Listing,
  plan: { requests: Requests; room: Room; stale: () => void },
) {
  const { requests, room } = plan;
  const state = { us: 0, at: 0, playing: false };

  const playheadAt = (now: number) => state.us + (state.playing ? (now - state.at) * 1000 : 0);

  // When a chunk must have arrived, in milliseconds: `now` for the chunk holding the playhead, and
  // undefined while paused or for a chunk that ends at or before the playhead.
  function deadline(index: number, now: number) {
    const { bounds } = listing.read().index;
    const atUs = playheadAt(now);
    if (!state.playing || bounds[index + 1]! <= atUs) return undefined;
    return now + Math.max(0, bounds[index]! - atUs) / 1000;
  }

  // Whether a request to a forwarder should go to the source instead: it is urgent, nothing of it
  // has arrived, it is expected after its deadline, and the source, online and with room, would
  // finish it sooner.
  function late([key, request]: [string, Request], now: number) {
    if (request.priority !== "urgent" || request.started || request.peer === options.source)
      return false;
    const due = deadline(request.slot.index, now);
    if (due === undefined || !options.links().has(request.peer)) return false;
    const expected = now + room.finish(request.peer, request);
    if (expected <= due || requests.refuses(key, options.source) || !room.room(options.source))
      return false;
    // copy: the request as the source would take it, asked after everything out.
    const own = { ...request, peer: options.source };
    return now + room.finish(options.source, own) < expected;
  }

  /**
   * The playhead was at `us` at time `at`, in milliseconds on the `now()` clock, playing or not.
   * Gives the chunks ahead deadlines or takes them away; nothing is placed or cancelled.
   */
  function playhead(us: number, at: number, playing: boolean) {
    Object.assign(state, { us, at, playing });
  }

  /** Sends the source what an urgent forwarder request would bring too late. */
  function progress() {
    const now = options.now();

    // A request moved to the source goes back into `out` under the same key, so this loop reaches
    // it again at the end; it isn't late then, being the source's.
    for (const entry of requests.out) {
      if (!late(entry, now)) continue;
      const [key, request] = entry;
      requests.cancel(key, request);
      requests.ask(request.slot, options.source, "urgent", request.bytes);
      // The forwarder's link has room again.
      plan.stale();
    }
  }

  return { playheadAt, playhead, progress };
}

// Runs `work` once, in a microtask, however many times it is asked for in one task.
function createBatch(work: () => void) {
  const state = { queued: false };

  return () => {
    if (state.queued) return;
    state.queued = true;

    queueMicrotask(() => {
      state.queued = false;
      work();
    });
  };
}

export function createFetchPlan(options: FetchPlanOptions) {
  const state = { full: false };
  // Events in one task are planned once.
  const stale = createBatch(pass);
  const requests = createRequests(options);
  const room = createRoom(options, requests.out);
  const listing = createListing(options);
  // An interest change ends a wait on full storage too.
  const wants = createWants(listing, () => {
    state.full = false;
    stale();
  });
  const placer = createPlacer(options, requests, room, wants);
  const clock = createClock(options, listing, { requests, room, stale });

  function pass() {
    const { index, ended } = listing.read();
    wants.refresh(index.bounds, ended);
    requests.settle(wants.priorityOf);
    if (state.full) return;
    const playhead = chunkAt(index.bounds, clock.playheadAt(options.now()), ended) ?? 0;

    for (const priority of PRIORITIES) {
      if (priority === "background" && requests.pressing()) return;
      placer.scan(priority, index, playhead);
    }
  }

  return {
    want: wants.want,
    /** A new page of the chunk index arrived, or the last was listed. */
    indexed() {
      listing.drop();
      stale();
    },
    playhead: clock.playhead,
    /** A piece of `bytes` of a chunk arrived from `peer`. */
    piece: requests.piece,
    /**
     * A chunk was stored, from `from`, or live when that is undefined: its request is done, or,
     * if another peer was asked, cancelled.
     */
    stored(slot: ChunkSlot, from?: KeyId) {
      const key = chunkKey(slot);
      const request = requests.out.get(key);
      requests.forget(key);
      if (from !== undefined) room.unblock(from);
      if (request?.peer === from) requests.out.delete(key);
      else if (request !== undefined) requests.cancel(key, request);
      stale();
    },
    /**
     * A chunk arrived from `peer` but wasn't stored, such as when storage is full: its request
     * ends, as a delivery done, and the chunk is placed again.
     */
    dropped(peer: KeyId, slot: ChunkSlot) {
      if (requests.end(peer, slot)) room.unblock(peer);
      stale();
    },
    /** `peer` has no room for this peer now. */
    busy(peer: KeyId, slot: ChunkSlot) {
      if (requests.end(peer, slot)) room.block(peer);
      stale();
    },
    /** `peer` doesn't hold a chunk, or can't cut it again. */
    gone(peer: KeyId, slot: ChunkSlot) {
      if (requests.end(peer, slot)) requests.refuse(slot, peer);
      stale();
    },
    /**
     * The link to `peer` closed, or the source went offline: its requests go back into the plan.
     */
    closed(peer: KeyId) {
      requests.closed(peer);
      room.unblock(peer);
      stale();
    },
    /**
     * A link opened, or a forwarder's ranges or capability record changed: it may be asked again
     * for what it answered `gone` or `busy` to.
     */
    heard(peer: KeyId) {
      requests.forgive(peer);
      room.unblock(peer);
      stale();
    },
    /** The source announced itself: what waited on it may be asked of it. */
    announced() {
      requests.forgive(options.source);
      stale();
    },
    /**
     * Storage filled, or freed: nothing more is placed while full or until an interest changes,
     * and requests that have sent nothing are cancelled. Returns whether this changed it.
     */
    storage(full: boolean) {
      const changed = state.full !== full;
      state.full = full;
      if (full) requests.halt();
      else stale();
      return changed;
    },
    progress: clock.progress,
  };
}

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// What the source sends next (docs/architecture.md#push-order): one queue for every chunk it
// sends, in four tiers. First the seek target's chunks, then chunks peers asked for, then chunks
// ahead of the playhead up to the push horizon, then peers' background requests, which go only
// when nothing above can. Ahead of the playhead, each index goes subtitles, then the audio tracks
// a peer selected, then video, so every track of a moment arrives before the next moment. A chunk
// goes out live once; after that, only to a peer that asks for it.
//
// The queue holds no chunks, only which to send next. The source asks for one whenever its stream
// will accept more, so pushing runs as fast as its upload, and on nothing else. Indexes are cut in
// order as the source demuxes, and a chunk can go only once it is cut, so what isn't cut yet
// waits.

import type { Catalog } from "./catalog";
import type { ChunkSlot } from "./chunk";
import { chunkAt } from "./chunk-index";
import type { KeyId } from "./crypto";

/** How far ahead of the playhead chunks are pushed live: 15 minutes. */
export const PUSH_HORIZON_US = 15 * 60 * 1_000_000;

/** A chunk to send: live on its `media/<track>`, or to one peer through its `deliver`. */
export type Send = { to: "track"; slot: ChunkSlot } | { to: "peer"; peer: KeyId; slot: ChunkSlot };

type Request = { peer: KeyId; slot: ChunkSlot };

export type PushQueueOptions = {
  /** The catalog's tracks, fixed for the session. */
  tracks: Catalog["tracks"];
  /**
   * Called when a change leaves something to send after `next` found nothing, so a source that
   * stopped asking asks again. It isn't called again until `next` finds nothing once more.
   */
  onQueued?: () => void;
};

const ids = (tracks: Catalog["tracks"], kind: Catalog["tracks"][number]["kind"]) =>
  // copy: once per session, a kind's few track ids, in order.
  tracks
    .filter((t) => t.kind === kind)
    .map((t) => t.id)
    .toSorted((a, b) => a - b);

const U32 = 0xffff_ffff;

const sameSlot = (a: ChunkSlot, b: ChunkSlot) => a.track === b.track && a.index === b.index;

// Whether a request is a peer's for a chunk.
const isRequest = (peer: KeyId, slot: ChunkSlot) => (r: Request) =>
  r.peer === peer && sameSlot(r.slot, slot);

const without = (requests: Request[], drop: (r: Request) => boolean) =>
  requests.filter((r) => !drop(r));

const toPeer = (r: Request): Send => ({ to: "peer", peer: r.peer, slot: r.slot });

// The chunks cut so far, in index order, found by time.
function createCuts() {
  // Each chunk ends where the next begins, as in the chunk index.
  const state = { bounds: [] as number[], ended: false };
  const count = () => Math.max(0, state.bounds.length - 1);

  function add(startUs: number, endUs: number) {
    const last = state.bounds.at(-1);
    const placed = endUs > startUs && (last === undefined || startUs === last);
    if (!placed) throw new RangeError("a chunk has a length and starts where the last ends");
    if (last === undefined) state.bounds.push(startUs);
    state.bounds.push(endUs);
  }

  return {
    covering: (us: number) => chunkAt(state.bounds, us, state.ended),
    add,
    has: (index: number) => index < count(),
    startOf: (index: number) => state.bounds[index]!,
    count,
    end: () => (state.ended = true),
    ended: () => state.ended,
  };
}

// Peers' requests, urgent or in the background, each queued once per peer.
function createRequests() {
  const state = { asked: [] as Request[], background: [] as Request[] };

  function drop(match: (r: Request) => boolean) {
    state.asked = without(state.asked, match);
    state.background = without(state.background, match);
  }

  // Queues a request, at the more urgent tier if the peer asked for it already.
  function add(request: Request, background: boolean) {
    const same = isRequest(request.peer, request.slot);
    if (state.asked.some(same)) return;

    if (!background) {
      state.background = without(state.background, same);
      state.asked.push(request);
    } else if (!state.background.some(same)) {
      state.background.push(request);
    }
  }

  // The requests for an index past the last, taken out.
  function takePast(count: number) {
    const past = (r: Request) => r.slot.index >= count;
    // copy: once per session, the requests past the end, from both tiers into one list.
    const gone = [...state.asked.filter(past), ...state.background.filter(past)];
    drop(past);
    return gone;
  }

  return {
    add,
    drop,
    takePast,
    asked: (ready: (r: Request) => boolean) => state.asked.find(ready),
    background: (ready: (r: Request) => boolean) => state.background.find(ready),
  };
}

type Cuts = ReturnType<typeof createCuts>;

// What goes live: the tracks in the order each index goes, which chunks have gone, and the seek
// target and playhead that say which go next.
function createLive(tracks: Catalog["tracks"], cuts: Cuts) {
  const subtitles = ids(tracks, "subtitle");
  const audio = ids(tracks, "audio");
  const video = ids(tracks, "video");
  const state = {
    playheadUs: 0,
    /** Where the latest seek went, until its chunks have gone. */
    targetUs: undefined as number | undefined,
    /** The tracks pushed live, in the order each index goes: no audio until one is selected. */
    // copy: once per session, the few track ids, in order.
    order: [...subtitles, ...video],
    /** Each track's indexes sent live. */
    pushed: new Map<number, Set<number>>(),
  };

  const sent = ({ track, index }: ChunkSlot) => state.pushed.get(track)?.has(index) === true;

  // The first chunk at an index not yet sent live, of the live tracks in the order they go.
  function unsentAt(index: number) {
    const track = state.order.find((t) => !sent({ track: t, index }));
    return track === undefined ? undefined : { track, index };
  }

  // The seek target's chunk not yet sent, forgetting the target once all have gone.
  function target(): ChunkSlot | undefined {
    if (state.targetUs === undefined) return undefined;
    const index = cuts.covering(state.targetUs);
    if (index === undefined) return undefined;
    const slot = unsentAt(index);
    if (slot === undefined) state.targetUs = undefined;
    return slot;
  }

  // The first chunk ahead of the playhead not yet sent live, up to the push horizon.
  function ahead(): ChunkSlot | undefined {
    const from = cuts.covering(state.playheadUs);
    if (from === undefined) return undefined;
    const until = state.playheadUs + PUSH_HORIZON_US;

    for (let index = from; cuts.has(index) && cuts.startOf(index) < until; index++) {
      const slot = unsentAt(index);
      if (slot !== undefined) return slot;
    }

    return undefined;
  }

  function markSent({ track, index }: ChunkSlot) {
    const indexes = state.pushed.get(track) ?? new Set();
    indexes.add(index);
    state.pushed.set(track, indexes);
  }

  function select(selected: Set<number>) {
    // copy: once per selection, the few track ids, in order.
    state.order = [...subtitles, ...audio.filter((t) => selected.has(t)), ...video];
  }

  function seek(us: number) {
    state.targetUs = us;
    state.playheadUs = us;
  }

  return {
    target,
    ahead,
    markSent,
    select,
    seek,
    playhead: (us: number) => (state.playheadUs = us),
  };
}

export function createPushQueue(options: PushQueueOptions) {
  const known = new Set(options.tracks.map((t) => t.id));
  const cuts = createCuts();
  const live = createLive(options.tracks, cuts);
  const requests = createRequests();
  /** Whether `next` found nothing, and `onQueued` hasn't been called since. */
  const state = { waiting: false };

  const isCut = (r: Request) => cuts.has(r.slot.index);

  // What to send next, without taking it. It forgets a seek target whose chunks have all gone.
  function pick(): Send | undefined {
    const targeted = live.target();
    if (targeted !== undefined) return { to: "track", slot: targeted };
    const asked = requests.asked(isCut);
    if (asked !== undefined) return toPeer(asked);
    const push = live.ahead();
    if (push !== undefined) return { to: "track", slot: push };
    const background = requests.background(isCut);
    return background === undefined ? undefined : toPeer(background);
  }

  // Calls `onQueued` when a change leaves something to send after `next` found nothing.
  function changed() {
    if (!state.waiting || pick() === undefined) return;
    state.waiting = false;
    options.onQueued?.();
  }

  /** The next chunk to send, taken from the queue, or undefined for none yet. */
  function next(): Send | undefined {
    const send = pick();
    if (send === undefined) state.waiting = true;
    else if (send.to === "peer") requests.drop(isRequest(send.peer, send.slot));
    else live.markSent(send.slot);
    return send;
  }

  /**
   * The next index is cut, covering `[startUs, endUs)`. Throws a `RangeError` unless it has a
   * length and starts where the last one ended.
   */
  function cut(startUs: number, endUs: number) {
    cuts.add(startUs, endUs);
    changed();
  }

  /**
   * Every chunk is cut: demuxing reached the end of the file. Returns the requests queued for an
   * index past the last chunk, taken out, for the source to answer `gone`.
   */
  function end() {
    cuts.end();
    const gone = requests.takePast(cuts.count());
    changed();
    return gone;
  }

  /** The playhead moved, as playback does. */
  function playhead(us: number) {
    live.playhead(us);
    changed();
  }

  /** A seek: the target's chunks go first, then the rest ahead of it. */
  function seek(us: number) {
    live.seek(us);
    changed();
  }

  /** The audio tracks at least one peer selects: only those are pushed. */
  function select(tracks: Iterable<number>) {
    live.select(new Set(tracks));
    changed();
  }

  /**
   * A peer asks for a chunk, urgently or in the background. Returns false, queueing nothing, for
   * a track the catalog lacks, an index that isn't one, or an index past the last chunk once every
   * chunk is cut, which the source answers `gone`.
   * A chunk asked for again by the same peer is queued once, at the more urgent of the two.
   */
  function request(peer: KeyId, slot: ChunkSlot, background = false) {
    if (!known.has(slot.track)) return false;
    if (!Number.isInteger(slot.index) || slot.index < 0 || slot.index > U32) return false;
    if (cuts.ended() && !cuts.has(slot.index)) return false;
    requests.add({ peer, slot }, background);
    changed();
    return true;
  }

  /** A peer cancelled its request for a chunk. */
  const cancel = (peer: KeyId, slot: ChunkSlot) => requests.drop(isRequest(peer, slot));

  /** A peer left: its requests go with it. */
  const left = (peer: KeyId) => requests.drop((r) => r.peer === peer);

  return { next, cut, end, playhead, seek, select, request, cancel, left };
}

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// What the source sends next (docs/architecture.md#push-order). Each index goes subtitles, then
// the selected audio, then video, so every track of a moment arrives before the next moment.
//
// The source asks for the next chunk whenever its stream will accept more, so pushing runs as
// fast as its upload allows, with no clock. It holds at most 4 requests per peer, so it stays
// bounded whatever a peer sends.

import type { Catalog } from "./catalog";
import { sameSlot, type ChunkSlot } from "./chunk";
import { chunkAt } from "./chunk-index";
import type { ChunkBusy, ChunkControl, ChunkGone } from "./chunk-requests";
import type { KeyId } from "./crypto";

/** How far ahead of the playhead chunks are pushed live: 15 minutes. */
export const PUSH_HORIZON_US = 15 * 60 * 1_000_000;

/** How many requests the source holds from each peer. */
export const SOURCE_ROOM = 4;

/** A chunk to send: live on its `media/<track>`, or to one peer through its `deliver`. */
export type Send = { to: "track"; slot: ChunkSlot } | { to: "peer"; peer: KeyId; slot: ChunkSlot };

// A peer's request. `at` orders requests by when they were first asked, as a count, not a time.
type Request = { peer: KeyId; slot: ChunkSlot; at: number };

export type PushQueueOptions = {
  /** The catalog's tracks, fixed for the session. */
  tracks: Catalog["tracks"];
  send(peer: KeyId, message: ChunkBusy | ChunkGone): void;
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

const isRequest = (peer: KeyId, slot: ChunkSlot) => (r: Request) =>
  r.peer === peer && sameSlot(r.slot, slot);

const without = (requests: Request[], drop: (r: Request) => boolean) =>
  requests.filter((r) => !drop(r));

const toPeer = (r: Request): Send => ({ to: "peer", peer: r.peer, slot: r.slot });

const countOf = (requests: Request[], peer: KeyId) =>
  requests.reduce((count, r) => (r.peer === peer ? count + 1 : count), 0);

function createCuts() {
  // `bounds` holds each chunk's start and then the last one's end, as the chunk index does: each
  // chunk ends where the next begins.
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

// Peers' requests, urgent or in the background, each queued once per peer, in each tier in the
// order first asked.
function createRequests() {
  const state = { asked: [] as Request[], background: [] as Request[], asks: 0 };

  function drop(match: (r: Request) => boolean) {
    state.asked = without(state.asked, match);
    state.background = without(state.background, match);
  }

  function insert(tier: Request[], request: Request) {
    const after = tier.findIndex((r) => r.at > request.at);
    tier.splice(after === -1 ? tier.length : after, 0, request);
  }

  // The peer's newest background request, taken out to make room for a more urgent one.
  function bump(peer: KeyId) {
    const newest = state.background.findLast((r) => r.peer === peer);
    if (newest !== undefined) state.background = without(state.background, (r) => r === newest);
    return newest;
  }

  // Queues a request at its tier; one asked before moves there and keeps when it was first asked.
  // A new urgent request beyond the peer's room takes the place of its newest background one,
  // returned as `bumped`; with none to take, nothing is queued.
  function add(peer: KeyId, slot: ChunkSlot, background: boolean) {
    const same = isRequest(peer, slot);
    const repeat = state.asked.find(same) ?? state.background.find(same);
    const full =
      repeat === undefined &&
      countOf(state.asked, peer) + countOf(state.background, peer) >= SOURCE_ROOM;
    const bumped = full && !background ? bump(peer) : undefined;
    if (full && bumped === undefined) return { queued: false, bumped };
    drop(same);
    insert(background ? state.background : state.asked, repeat ?? { peer, slot, at: state.asks++ });
    return { queued: true, bumped };
  }

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
    pushed: new Map<number, Set<number>>(),
  };

  const sent = ({ track, index }: ChunkSlot) => state.pushed.get(track)?.has(index) === true;

  function unsentAt(index: number) {
    const track = state.order.find((t) => !sent({ track: t, index }));
    return track === undefined ? undefined : { track, index };
  }

  // The seek target's next unsent chunk. Forgets the target once all its chunks have gone.
  function target(): ChunkSlot | undefined {
    if (state.targetUs === undefined) return undefined;
    const index = cuts.covering(state.targetUs);
    if (index === undefined) return undefined;
    const slot = unsentAt(index);
    if (slot === undefined) state.targetUs = undefined;
    return slot;
  }

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

  const answer = (peer: KeyId, type: "busy" | "gone", { track, index }: ChunkSlot) =>
    options.send(peer, { type, track, index });

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
   * Every chunk is cut: demuxing reached the end of the file. The requests queued for an index
   * past the last chunk are taken out and answered `gone`.
   */
  function end() {
    cuts.end();
    for (const r of requests.takePast(cuts.count())) answer(r.peer, "gone", r.slot);
    changed();
  }

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

  // A peer asks for a chunk, urgently or in the background. A track the catalog lacks, or an index
  // past the last chunk once every chunk is cut, is answered `gone`, and a request with no room
  // `busy`.
  function request(peer: KeyId, slot: ChunkSlot, background: boolean) {
    if (!known.has(slot.track) || (cuts.ended() && !cuts.has(slot.index))) {
      answer(peer, "gone", slot);
      return;
    }

    const { queued, bumped } = requests.add(peer, slot, background);
    if (bumped !== undefined) answer(peer, "busy", bumped.slot);
    if (queued) changed();
    else answer(peer, "busy", slot);
  }

  const left = (peer: KeyId) => requests.drop((r) => r.peer === peer);

  /**
   * Takes a peer's `request` or `cancel`; any other message is ignored. A request at any
   * priority but `background` goes with those asked, and one asked before takes the newer
   * priority, keeping when it was first asked and taking no more room.
   */
  function requested(peer: KeyId, message: ChunkControl) {
    const slot = { track: message.track, index: message.index };
    if (message.type === "cancel") requests.drop(isRequest(peer, slot));
    if (message.type === "request") request(peer, slot, message.priority === "background");
  }

  return { next, cut, end, playhead, seek, select, left, requested };
}

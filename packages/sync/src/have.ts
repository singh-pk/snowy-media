// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Have ranges (docs/architecture.md#have-ranges). They aren't signed: on the relay, only the peer
// may publish its broadcast, and a direct link is the peer's own. `n` starts from the publisher's
// creation time in ms, so it grows across reconnects and reloads, and an update from before one,
// arriving late on another path, can never pass for a newer one.

import { isCount, isRecord } from "./chat";
import type { ChunkSlot } from "./chunk";
import { seal, unseal, type Bytes, type KeyId, type SealedObject } from "./crypto";

/** One track's ranges: each `[start, end)` of indexes, in increasing order, with gaps between. */
export type TrackRanges = { track: number; ranges: [number, number][] };

export type Have = { n: number; tracks: TrackRanges[] };

export type HaveControl = { type: "have" } & Have;

/** Have ranges that don't open or aren't well formed. */
export class InvalidHaveError extends Error {
  override name = "InvalidHaveError";
}

const U16 = 0xffff;
// One past the highest index, which a range's end may be.
const INDEXES = 0x1_0000_0000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const haveKey = (peer: KeyId, n: number) => `have/${peer}@${n}`;

/** Indexes as ranges, in order, each as long as it can be. */
export function rangesOf(indexes: Iterable<number>): [number, number][] {
  // copy: the caller's indexes, each once, into an array to sort.
  const sorted = [...new Set(indexes)].toSorted((a, b) => a - b);
  const ranges: [number, number][] = [];

  for (const index of sorted) {
    const last = ranges.at(-1);
    if (last !== undefined && last[1] === index) last[1] = index + 1;
    else ranges.push([index, index + 1]);
  }

  return ranges;
}

function holds(tracks: TrackRanges[], { track, index }: ChunkSlot) {
  const ranges = tracks.find((t) => t.track === track)?.ranges ?? [];
  return ranges.some(([start, end]) => start <= index && index < end);
}

function checkTrack(value: unknown): TrackRanges | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 2) return undefined;

  const { track, ranges } = value;
  if (!isCount(track, 0) || track > U16 || !Array.isArray(ranges)) return undefined;
  // A track holding nothing is left out, so each holding has one spelling.
  if (ranges.length === 0) return undefined;
  const checked: [number, number][] = [];

  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2) return undefined;
    const [start, end] = range;
    if (!isCount(start, 0) || !isCount(end, 0) || start >= end || end > INDEXES) return undefined;
    const last = checked.at(-1);
    if (last !== undefined && start <= last[1]) return undefined;
    checked.push([start, end]);
  }

  return { track, ranges: checked };
}

/** Ranges received from a peer, checked: each track once, in order, and nothing else. */
export function checkHave(value: unknown): Have | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 2) return undefined;

  const { n, tracks } = value;
  if (!isCount(n, 1) || !Array.isArray(tracks)) return undefined;
  const checked: TrackRanges[] = [];

  for (const entry of tracks) {
    const track = checkTrack(entry);
    const last = checked.at(-1);
    if (track === undefined || (last !== undefined && track.track <= last.track)) return undefined;
    checked.push(track);
  }

  return { n, tracks: checked };
}

/** A `have` message received from a peer, checked, or undefined for anything else. */
export function checkHaveControl(value: unknown): HaveControl | undefined {
  if (!isRecord(value) || value.type !== "have") return undefined;
  const { n, tracks } = value;
  const have = checkHave({ n, tracks });
  return have === undefined ? undefined : { type: "have", n: have.n, tracks: have.tracks };
}

/**
 * Seals a forwarder's ranges, for its `have` track. Throws a `RangeError` for ranges a peer
 * would refuse, so a forwarder's mistake shows where it is made.
 */
export async function sealHave(content: CryptoKey, peer: KeyId, have: Have): Promise<SealedObject> {
  if (checkHave(have) === undefined) throw new RangeError("malformed have ranges");
  const key = haveKey(peer, have.n);
  const sealed = await seal(content, key, encoder.encode(JSON.stringify(have.tracks)));
  return { key, sealed };
}

/**
 * Opens ranges from `peer`'s `have` track. Rejects with an `InvalidHaveError` for a key that
 * isn't that peer's, bytes that don't open, or ranges that aren't well formed.
 */
export async function openHave(content: CryptoKey, peer: KeyId, { key, sealed }: SealedObject) {
  const prefix = `have/${peer}@`;
  const n = Number(key.substring(prefix.length));

  if (!key.startsWith(prefix) || !isCount(n, 1) || key !== haveKey(peer, n)) {
    throw new InvalidHaveError(`not ${peer}'s have: ${key}`);
  }

  const bytes = await opened(content, key, sealed);
  const have = checkHave({ n, tracks: parsed(bytes) });
  if (have === undefined) throw new InvalidHaveError("malformed");
  return have;
}

async function opened(content: CryptoKey, key: string, sealed: Bytes) {
  try {
    return await unseal(content, key, sealed);
  } catch {
    throw new InvalidHaveError("doesn't open");
  }
}

function parsed(bytes: Bytes): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return undefined;
  }
}

export type HavePublisherOptions = {
  /**
   * What this forwarder holds now, read from the store as each update goes, leaving out tracks
   * that hold nothing.
   */
  tracks(): TrackRanges[];
  /** Publishes an update: on the `have` track, and to the peers linked directly. */
  send(have: Have): void;
};

/**
 * Publishes this forwarder's ranges: the first as soon as the stream will accept it, then one
 * whenever the store has changed and the stream will accept more, so a burst of stores becomes one
 * update.
 */
export function createHavePublisher(options: HavePublisherOptions) {
  const state = { n: Date.now(), changed: true, writable: false };

  function publish() {
    if (!state.changed || !state.writable) return;
    state.n++;
    state.changed = false;
    state.writable = false;
    options.send({ n: state.n, tracks: options.tracks() });
  }

  /** A chunk was stored or evicted. */
  function changed() {
    state.changed = true;
    publish();
  }

  /** The stream will accept more: the writer's `ready` resolved. */
  function writable() {
    state.writable = true;
    publish();
  }

  return { changed, writable };
}

/** The newest ranges of each forwarder this peer hears from. */
export function createHaves() {
  const haves = new Map<KeyId, Have>();

  /** Takes ranges from a peer, keeping them if they are newer. Returns whether they were kept. */
  function receive(peer: KeyId, have: Have) {
    const held = haves.get(peer);
    if (held !== undefined && held.n >= have.n) return false;
    haves.set(peer, have);
    return true;
  }

  /** Forgets a peer's ranges: its broadcast was withdrawn. */
  function forget(peer: KeyId) {
    haves.delete(peer);
  }

  /** The peers whose newest ranges hold a chunk. */
  function holders(slot: ChunkSlot) {
    const found: KeyId[] = [];

    for (const [peer, have] of haves) {
      if (holds(have.tracks, slot)) found.push(peer);
    }

    return found;
  }

  return { receive, forget, holders };
}

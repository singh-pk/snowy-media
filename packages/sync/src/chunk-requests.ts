// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The messages that ask for chunks (docs/architecture.md#serving-requests), and the forwarder's
// side that answers them. It sends one chunk at a time on each link, the most urgent and then the
// oldest asked first, so a seek's chunk waits for at most the one already on the wire.

import { isCount, isRecord } from "./chat";
import { chunkKey, type ChunkSlot } from "./chunk";
import type { Bytes, KeyId } from "./crypto";
import type { FetchPriority } from "./fetch-plan";

/** Asks for a chunk, on `data` from a forwarder or `deliver` from the source. */
type ChunkRequest = { type: "request"; priority: FetchPriority } & ChunkSlot;
type ChunkCancel = { type: "cancel" } & ChunkSlot;
/** The sender has no room for this asker now. */
export type ChunkBusy = { type: "busy" } & ChunkSlot;
/** The sender doesn't hold the chunk, or can't cut it again. */
export type ChunkGone = { type: "gone" } & ChunkSlot;

export type ChunkControl = ChunkRequest | ChunkCancel | ChunkBusy | ChunkGone;

const U16 = 0xffff;
const U32 = 0xffff_ffff;
const RANK: Record<FetchPriority, number> = { urgent: 0, ahead: 1, background: 2 };

const isPriority = (value: unknown): value is FetchPriority =>
  value === "urgent" || value === "ahead" || value === "background";

/** A chunk message received from a peer, checked, or undefined for anything else. */
export function checkChunkControl(value: unknown): ChunkControl | undefined {
  if (!isRecord(value)) return undefined;

  const { type, track, index, priority } = value;
  if (!isCount(track, 0) || track > U16 || !isCount(index, 0) || index > U32) return undefined;
  if (type === "request")
    return isPriority(priority) ? { type, track, index, priority } : undefined;
  if (type === "cancel" || type === "busy" || type === "gone") return { type, track, index };
  return undefined;
}

export type ChunkServerOptions = {
  /**
   * How many requests from `peer` this forwarder takes now, the one it is sending included: by
   * its own measures of the link, or 0 when it has no slot for that peer.
   */
  room(peer: KeyId): number;
  holds(slot: ChunkSlot): boolean;
  /** A held chunk's sealed bytes, or undefined if it was evicted since. */
  read(slot: ChunkSlot): Promise<Bytes | undefined>;
  send(peer: KeyId, message: ChunkBusy | ChunkGone): void;
  /**
   * Sends a chunk to a peer on its `data` channel, stopping between pieces once `signal` aborts.
   * Settles once it has all gone out, or stopped.
   */
  deliver(peer: KeyId, key: string, bytes: Bytes, signal: AbortSignal): Promise<unknown>;
};

type Queued = { slot: ChunkSlot; priority: FetchPriority };

// One asker's requests: those waiting, in the order first asked, and the one on the wire, which
// a `cancel` stops.
type Asker = {
  waiting: Map<string, Queued>;
  sending: { key: string; stop: AbortController } | undefined;
};

// The key of the chunk an asker has on the wire and still wants.
const onWire = (asker: Asker) =>
  asker.sending?.stop.signal.aborted === false ? asker.sending.key : undefined;

// The request to send next: the most urgent, then the oldest asked, which comes first in the map.
function first(waiting: Map<string, Queued>) {
  return waiting
    .entries()
    .reduce<[string, Queued] | undefined>(
      (best, entry) => (best && RANK[best[1].priority] <= RANK[entry[1].priority] ? best : entry),
      undefined,
    );
}

export function createChunkServer(options: ChunkServerOptions) {
  const askers = new Map<KeyId, Asker>();

  // A held chunk's bytes, or undefined if it can't be read: either way the asker hears back.
  async function readable(slot: ChunkSlot) {
    try {
      return await options.read(slot);
    } catch {
      return undefined;
    }
  }

  // Sends a chunk, settling either way: a link that fails to send closes, which drops the rest.
  async function delivered(peer: KeyId, key: string, bytes: Bytes, signal: AbortSignal) {
    try {
      await options.deliver(peer, key, bytes, signal);
    } catch {
      // The link's close event follows.
    }
  }

  // A chunk cancelled while it was read isn't sent.
  async function drain(peer: KeyId, asker: Asker) {
    for (let next = first(asker.waiting); next !== undefined; next = first(asker.waiting)) {
      if (askers.get(peer) !== asker) return;
      const [key, { slot }] = next;
      const stop = new AbortController();
      asker.sending = { key, stop };
      asker.waiting.delete(key);
      const bytes = await readable(slot);
      if (askers.get(peer) !== asker) return;
      const { aborted } = stop.signal;
      if (!aborted && bytes === undefined)
        options.send(peer, { type: "gone", track: slot.track, index: slot.index });
      if (!aborted && bytes !== undefined) await delivered(peer, key, bytes, stop.signal);
      // In the same turn as the last answer, so a request it prompts finds the room free.
      if (asker.waiting.size === 0) asker.sending = undefined;
    }
  }

  function request(peer: KeyId, { track, index, priority }: ChunkRequest) {
    const slot = { track, index };
    const key = chunkKey(slot);
    const asker: Asker = askers.get(peer) ?? { waiting: new Map(), sending: undefined };
    askers.set(peer, asker);
    const queued = asker.waiting.get(key);
    // The chunk on the wire is already being sent.
    if (onWire(asker) === key) return;

    // The same request, with the newer priority; it keeps its place in the map.
    if (queued !== undefined) {
      queued.priority = priority;
      return;
    }

    if (!options.holds(slot)) {
      options.send(peer, { type: "gone", track: slot.track, index: slot.index });
      return;
    }

    // A cancelled chunk still settling takes no room: the asker counts it ended.
    if (asker.waiting.size + (onWire(asker) === undefined ? 0 : 1) >= options.room(peer)) {
      options.send(peer, { type: "busy", track: slot.track, index: slot.index });
      return;
    }

    asker.waiting.set(key, { slot, priority });
    if (asker.sending === undefined) void drain(peer, asker);
  }

  /** Answers a `request` or `cancel` from `peer`; any other message is ignored. */
  function requested(peer: KeyId, message: ChunkControl) {
    if (message.type === "request") request(peer, message);
    if (message.type === "cancel") cancel(peer, chunkKey(message));
  }

  function cancel(peer: KeyId, key: string) {
    const asker = askers.get(peer);
    if (asker === undefined) return;
    if (onWire(asker) === key) asker.sending!.stop.abort();
    else asker.waiting.delete(key);
  }

  function closed(peer: KeyId) {
    askers.delete(peer);
  }

  return { requested, closed };
}

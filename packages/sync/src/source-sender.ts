// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// What the source sends, as fast as its stream takes it (docs/architecture.md#push-order): each
// chunk the push queue picks goes live on its track or to the peer that asked, through `deliver`
// on that peer's newest link. Peers' requests and cancels on each link go into the queue, and a
// peer whose last link closes leaves it.

import type { Catalog } from "./catalog";
import { chunkKey, sameSlot, type ChunkSlot } from "./chunk";
import { checkChunkControl } from "./chunk-requests";
import type { Bytes, KeyId } from "./crypto";
import type { Link } from "./link";
import { createPushQueue, type Send } from "./push-queue";

export type SourceSenderOptions = {
  /** The catalog's tracks, fixed for the session. */
  tracks: Catalog["tracks"];
  /** Resolves once the stream will take another chunk. */
  ready(): Promise<void>;
  /**
   * A chunk's sealed object, cut again from the file if need be, or undefined when it can't be,
   * such as a body that no longer matches its signed header: a peer that asked is answered
   * `gone`, and a live chunk is skipped.
   */
  chunk(slot: ChunkSlot): Promise<Bytes | undefined>;
  /** Sends a chunk live, on `source/media/<track>`. */
  live(slot: ChunkSlot, bytes: Bytes): void;
  /** Sending stopped because `ready`, `chunk`, `live` or a link's send threw, with its error. */
  stopped(error: unknown): void;
};

// The chunk being cut for a peer. The queue no longer holds it, so a cancel or the peer leaving
// while it is cut drops it here instead, and the peer asking for it again is the same request.
function createCutting() {
  const state = {
    now: undefined as { peer: KeyId; slot: ChunkSlot; dropped: boolean } | undefined,
  };

  function start(send: Send) {
    state.now =
      send.to === "peer" ? { peer: send.peer, slot: send.slot, dropped: false } : undefined;
  }

  // Whether the chunk cut since `start` was dropped.
  function end() {
    const dropped = state.now?.dropped === true;
    state.now = undefined;
    return dropped;
  }

  // Drops the peer's chunk being cut: `slot`'s, or any.
  function drop(peer: KeyId, slot?: ChunkSlot) {
    const now = state.now;
    if (now?.peer === peer && (slot === undefined || sameSlot(slot, now.slot))) now.dropped = true;
  }

  // Whether `slot` is the peer's chunk being cut, which then goes to it even if dropped before.
  function asked(peer: KeyId, slot: ChunkSlot) {
    const now = state.now;
    if (now?.peer !== peer || !sameSlot(slot, now.slot)) return false;
    now.dropped = false;
    return true;
  }

  return { start, end, drop, asked };
}

export function createSourceSender(options: SourceSenderOptions) {
  const links = new Map<KeyId, Link[]>();
  const state = { stopped: false, queued: Promise.withResolvers<void>() };
  const cutting = createCutting();
  const queue = createPushQueue({
    tracks: options.tracks,
    send: (peer, message) => links.get(peer)?.at(-1)?.send(message),
    onQueued: () => state.queued.resolve(),
  });

  // Waits until the queue has something again, or sending stops.
  function queued() {
    state.queued = Promise.withResolvers<void>();
    return state.queued.promise;
  }

  function sent(send: Send, bytes: Bytes | undefined) {
    if (send.to === "track") {
      if (bytes !== undefined) options.live(send.slot, bytes);
      return;
    }

    // A peer with no link left has dropped its send, so it has a link here.
    const link = links.get(send.peer)!.at(-1)!;
    const { track, index } = send.slot;
    if (bytes === undefined) link.send({ type: "gone", track, index });
    else link.deliver(chunkKey(send.slot), bytes);
  }

  async function step() {
    await options.ready();
    if (state.stopped) return;
    const send = queue.next();

    if (send === undefined) {
      await queued();
      return;
    }

    cutting.start(send);
    const bytes = await options.chunk(send.slot);
    if (!cutting.end() && !state.stopped) sent(send, bytes);
  }

  async function run() {
    try {
      while (!state.stopped) await step();
    } catch (error) {
      if (!state.stopped) options.stopped(error);
    }
  }

  function unlinked(link: Link) {
    const { peer } = link;
    // A link is listed from `connect` until it closes, once.
    const rest = links.get(peer)!.filter((l) => l !== link);

    if (rest.length > 0) {
      links.set(peer, rest);
      return;
    }

    links.delete(peer);
    queue.left(peer);
    cutting.drop(peer);
  }

  /** A link to a peer opened: its requests and cancels go into the queue. */
  function connect(link: Link) {
    const held = links.get(link.peer);
    if (held) held.push(link);
    else links.set(link.peer, [link]);
    link.on("message", (value) => {
      const control = checkChunkControl(value);
      if (control === undefined || state.stopped) return;
      if (control.type === "cancel") cutting.drop(link.peer, control);
      if (control.type === "request" && cutting.asked(link.peer, control)) return;
      queue.requested(link.peer, control);
    });
    link.on("close", () => unlinked(link));
  }

  /**
   * Stops sending: nothing more goes, not even a chunk being cut, and links' messages are ignored.
   * Links stay held until they close.
   */
  function stop() {
    state.stopped = true;
    state.queued.resolve();
  }

  void run();
  const { cut, end, playhead, seek, select } = queue;
  return { connect, stop, cut, end, playhead, seek, select };
}

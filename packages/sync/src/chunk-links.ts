// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A peer's chunk traffic on its links (docs/architecture.md#media-delivery). The fetch plan's
// requests and cancels go out on the asked peer's newest link; `busy` and `gone` replies, and the
// chunks peers deliver, go back to the plan and the store; and other peers' requests go to the
// chunk server, answered from the store. A link that closes takes every request with that peer
// with it, both ways, and the plan places them again.
//
// Over the relay an object goes whole: it arrives as one piece, and a cancel stops only a chunk
// whose delivery hasn't begun.

import { chunkSlot, InvalidChunkError } from "./chunk";
import { checkChunkControl, createChunkServer } from "./chunk-requests";
import type { openChunkStore } from "./chunk-store";
import type { Bytes, KeyId } from "./crypto";
import { createFetchPlan, type FetchPlanOptions, type LinkMeasures } from "./fetch-plan";
import type { Link } from "./link";

type ChunkStore = Awaited<ReturnType<typeof openChunkStore>>;

export type ChunkLinksOptions = {
  /** What the fetch plan reads of the session: the source, the index, holdings and the clock. */
  plan: Omit<FetchPlanOptions, "links" | "ask" | "cancel">;
  /** The local store, which chunks peers deliver go into and requests are answered from. */
  store: Pick<ChunkStore, "put" | "get" | "has">;
  /**
   * A peer's measures, its link's RTT and throughput, read when its first link opens: an object
   * the caller keeps current as it measures the link.
   */
  measures(peer: KeyId): LinkMeasures;
  /**
   * How many requests from `peer` this peer takes now, the one it is sending included, or 0 when
   * it has no slot for that peer.
   */
  room(peer: KeyId): number;
  /**
   * A delivered chunk didn't fit in storage: nothing more is fetched until the consumer frees
   * some, then calls the plan's `storage(false)`, or changes an interest.
   */
  full(): void;
};

const isQuota = (error: unknown) =>
  error instanceof DOMException && error.name === "QuotaExceededError";

export function createChunkLinks(options: ChunkLinksOptions) {
  const links = new Map<KeyId, Link[]>();
  const measured = new Map<KeyId, LinkMeasures>();
  const newest = (peer: KeyId) => links.get(peer)?.at(-1);

  const plan = createFetchPlan({
    // copy: once per session, what the plan reads, with the links it asks on.
    ...options.plan,
    links: () => measured,
    ask: ({ slot, peer, priority }) =>
      newest(peer)?.send({ type: "request", track: slot.track, index: slot.index, priority }),
    cancel: ({ slot, peer }) =>
      newest(peer)?.send({ type: "cancel", track: slot.track, index: slot.index }),
  });

  const server = createChunkServer({
    room: (peer) => options.room(peer),
    holds: options.store.has,
    read: options.store.get,
    send: (peer, message) => newest(peer)?.send(message),
    deliver: (peer, key, bytes) => Promise.resolve(newest(peer)?.deliver(key, bytes)),
  });

  function received(peer: KeyId, value: unknown) {
    const control = checkChunkControl(value);
    if (control === undefined) return;
    const slot = { track: control.track, index: control.index };
    if (control.type === "busy") plan.busy(peer, slot);
    else if (control.type === "gone") plan.gone(peer, slot);
    else server.requested(peer, control);
  }

  // Stores a delivered chunk: `kept` once it is stored, or was already stored or being stored.
  // A write that fails for another reason drops the chunk, which the plan asks for again.
  async function put(key: string, sealed: Bytes) {
    try {
      await options.store.put({ key, sealed });
      return "kept";
    } catch (error) {
      if (error instanceof InvalidChunkError) return "invalid";
      return isQuota(error) ? "full" : "failed";
    }
  }

  // A chunk a peer delivered. One that doesn't check out counts as `gone` from that peer, so it
  // isn't asked for that chunk again until its ranges change.
  async function object(peer: KeyId, key: string, bytes: Bytes) {
    const slot = chunkSlot(key);
    if (slot === undefined) return;
    plan.piece(slot, peer, bytes.byteLength);
    const outcome = await put(key, bytes);
    if (outcome === "kept") plan.stored(slot, peer);
    else if (outcome === "invalid") plan.gone(peer, slot);
    else plan.dropped(peer, slot);
    if (outcome !== "full") return;
    plan.storage(true);
    options.full();
  }

  // A link closed: requests both ways with its peer go, and the plan places its own again, on the
  // peer's other links or elsewhere.
  function unlinked(link: Link) {
    const { peer } = link;
    // A link is listed from `connect` until it closes, once.
    const rest = links.get(peer)!.filter((l) => l !== link);

    if (rest.length > 0) {
      links.set(peer, rest);
    } else {
      links.delete(peer);
      measured.delete(peer);
    }

    server.closed(peer);
    plan.closed(peer);
  }

  /** A link to a peer opened: it may be asked for chunks, and its requests are answered. */
  function connect(link: Link) {
    const { peer } = link;
    const held = links.get(peer);

    if (held) {
      held.push(link);
    } else {
      links.set(peer, [link]);
      measured.set(peer, options.measures(peer));
    }

    link.on("message", (value) => received(peer, value));
    link.on("object", (key, bytes) => object(peer, key, bytes));
    link.on("close", () => unlinked(link));
    plan.heard(peer);
  }

  return { connect, plan };
}

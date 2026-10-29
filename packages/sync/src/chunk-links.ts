// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A peer's chunk traffic on its links (docs/architecture.md#media-delivery). The fetch plan's
// requests go out on the asked peer's newest link, and a request's cancel or urgent re-ask on the
// link it went out on, whose server holds it; `busy` and `gone` replies, and the chunks peers
// deliver, go back to the plan and the store; and other peers' requests are answered
// from the store on the link each came on, by a chunk server per link. A link that closes puts
// every request this peer made of its peer back into the plan, and drops the requests that came
// on it.
//
// Over the relay an object goes whole: it arrives as one piece, and a cancel stops only a chunk
// whose delivery hasn't begun.

import { chunkKey, chunkSlot, InvalidChunkError, type ChunkSlot } from "./chunk";
import { checkChunkControl, createChunkServer } from "./chunk-requests";
import type { openChunkStore } from "./chunk-store";
import type { Bytes, KeyId } from "./crypto";
import { createFetchPlan, type FetchPlanOptions, type LinkMeasures } from "./fetch-plan";
import type { Link } from "./link";

type ChunkStore = Awaited<ReturnType<typeof openChunkStore>>;
type ChunkServer = ReturnType<typeof createChunkServer>;

export type ChunkLinksOptions = {
  /** What the fetch plan reads of the session: the source, the index, holdings and the clock. */
  plan: Omit<FetchPlanOptions, "links" | "ask" | "cancel">;
  /** The local store, which chunks peers deliver go into and requests are answered from. */
  store: Pick<ChunkStore, "put" | "get" | "has">;
  /** A link's measures, its RTT and throughput: an object the caller keeps current. */
  measures(link: Link): LinkMeasures;
  /**
   * How many requests this peer takes on a link now, the one it is sending included, or 0 when it
   * has no slot for that link's peer.
   */
  room(link: Link): number;
  /**
   * A delivered chunk couldn't be stored: `QuotaExceededError` when storage is full, or the
   * write's own error. Nothing more is fetched, and the requests that have sent nothing are
   * cancelled, until the consumer frees or mends storage and calls the plan's `storage(false)`,
   * or changes an interest. Called once each time fetching stops.
   */
  stopped(error: unknown): void;
};

// Stores a delivered chunk: `kept` once it is stored, `copy` for one stored or being stored
// already, whose own delivery ends or cancels its request, or why it couldn't be.
async function put(store: ChunkLinksOptions["store"], key: string, sealed: Bytes) {
  try {
    const fresh = await store.put({ key, sealed });
    return fresh ? "kept" : "copy";
  } catch (error) {
    return error instanceof InvalidChunkError ? "invalid" : { error };
  }
}

const keyOf = (peer: KeyId, slot: ChunkSlot) => `${peer} ${chunkKey(slot)}`;

// The link each open request went out on, by peer and chunk, until it is answered, delivered,
// cancelled or its link closes: that link's end holds it, so only that link can change it.
function createSent() {
  const sent = new Map<string, Link>();

  // The link a request goes on: the one it went out on, or else `newest`.
  function take(peer: KeyId, slot: ChunkSlot, newest: Link) {
    const key = keyOf(peer, slot);
    const link = sent.get(key) ?? newest;
    sent.set(key, link);
    return link;
  }

  // The request ended: returns the link it went out on, if it went out.
  function end(peer: KeyId, slot: ChunkSlot) {
    const key = keyOf(peer, slot);
    const link = sent.get(key);
    sent.delete(key);
    return link;
  }

  function closed(link: Link) {
    for (const [key, to] of sent) if (to === link) sent.delete(key);
  }

  return { take, end, closed };
}

export function createChunkLinks(options: ChunkLinksOptions) {
  const links = new Map<KeyId, Link[]>();
  const measured = new Map<KeyId, LinkMeasures>();
  const newest = (peer: KeyId) => links.get(peer)?.at(-1);
  const sent = createSent();

  const plan = createFetchPlan({
    // copy: once per session, what the plan reads, with the links it asks on.
    ...options.plan,
    links: () => measured,
    // The plan asks only the peers in `measured`, each of which has a link.
    ask: ({ slot, peer, priority }) =>
      sent
        .take(peer, slot, newest(peer)!)
        .send({ type: "request", track: slot.track, index: slot.index, priority }),
    cancel: ({ slot, peer }) =>
      sent.end(peer, slot)?.send({ type: "cancel", track: slot.track, index: slot.index }),
  });

  function received(peer: KeyId, server: ChunkServer, value: unknown) {
    const control = checkChunkControl(value);
    if (control === undefined) return;
    const slot = { track: control.track, index: control.index };

    if (control.type === "request" || control.type === "cancel") {
      server.requested(peer, control);
      return;
    }

    sent.end(peer, slot);
    if (control.type === "busy") plan.busy(peer, slot);
    else plan.gone(peer, slot);
  }

  // A chunk a peer delivered. One that doesn't check out counts as `gone` from that peer, so it
  // isn't asked for that chunk again until its ranges change; one that couldn't be stored stops
  // fetching, so a store that can't write doesn't fetch the same chunks again and again.
  async function object(peer: KeyId, key: string, bytes: Bytes) {
    const slot = chunkSlot(key);
    if (slot === undefined) return;
    sent.end(peer, slot);
    plan.piece(slot, peer, bytes.byteLength);
    const outcome = await put(options.store, key, bytes);
    if (outcome === "kept") plan.stored(slot, peer);
    else if (outcome === "invalid") plan.gone(peer, slot);
    else plan.dropped(peer, slot);
    if (typeof outcome === "object" && plan.storage(true)) options.stopped(outcome.error);
  }

  function measure(peer: KeyId) {
    const link = newest(peer);
    if (link === undefined) measured.delete(peer);
    else measured.set(peer, options.measures(link));
  }

  // A link closed: the requests that came on it go with its server, and the plan places what it
  // asked of that peer again, on the peer's other links or elsewhere.
  function unlinked(link: Link, server: ChunkServer) {
    const { peer } = link;
    // A link is listed from `connect` until it closes, once.
    const rest = links.get(peer)!.filter((l) => l !== link);
    if (rest.length > 0) links.set(peer, rest);
    else links.delete(peer);
    sent.closed(link);
    measure(peer);
    server.closed(peer);
    plan.closed(peer);
  }

  /** A link to a peer opened: it may be asked for chunks, and its requests are answered on it. */
  function connect(link: Link) {
    const { peer } = link;
    const held = links.get(peer);
    if (held) held.push(link);
    else links.set(peer, [link]);
    measure(peer);
    const server = createChunkServer({
      room: () => options.room(link),
      holds: options.store.has,
      read: options.store.get,
      send: (_, message) => link.send(message),
      deliver: (_, key, bytes) => Promise.resolve(link.deliver(key, bytes)),
    });
    link.on("message", (value) => received(peer, server, value));
    link.on("object", (key, bytes) => object(peer, key, bytes));
    link.on("close", () => unlinked(link, server));
    plan.heard(peer);
  }

  return { connect, plan };
}

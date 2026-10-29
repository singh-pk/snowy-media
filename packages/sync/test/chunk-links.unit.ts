// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A peer's chunk traffic on its links (src/chunk-links.ts), in Chromium, over links in memory: the
// plan's requests go on the asked peer's newest link and its cancels follow them; chunks delivered
// are stored and end their requests; `busy` and `gone` replies, a chunk that doesn't check out and
// one storage has no room for each move a chunk on as the design says; a closed link's requests
// are placed again; and other peers' requests are answered from the store.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { InvalidChunkError } from "../src/chunk";
import { createChunkLinks } from "../src/chunk-links";
import { checkChunkControl } from "../src/chunk-requests";
import type { Bytes, SealedObject } from "../src/crypto";
import type { LinkMeasures, Want } from "../src/fetch-plan";
import type { Link } from "../src/link";
import { createNetwork } from "./support/memory-link";

const SECOND = 1_000_000;
// Every chunk: 50 kB. A forwarder's link of 10 ms and 1000 B/ms then has room for 2 requests, and
// finishes a chunk in 60 ms, far sooner than the source's 1 s and 1000 B/ms, at 1050 ms; but the
// source's link holds 1 MB in flight, so it has room for every chunk, up to the 4 it holds.
const CHUNK = 50_000;
const FAST: LinkMeasures = { rttMs: 10, bytesPerMs: 1000 };
const FAR: LinkMeasures = { rttMs: 1000, bytesPerMs: 1000 };
const URGENT: Want = { tracks: [0], fromUs: 0, toUs: 8 * SECOND, priority: "urgent" };

// What linked peers heard from this one, as events a test can wait for.
function createHearing() {
  const heard: string[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];

  function hear(event: string) {
    heard.push(event);
    for (const waiter of waiters) if (heard.length >= waiter.count) waiter.resolve();
  }

  // Resolves once `count` events have been heard in all.
  function until(count: number) {
    const { promise, resolve } = Promise.withResolvers<void>();
    waiters.push({ count, resolve });
    if (heard.length >= count) resolve();
    return promise;
  }

  return { heard, hear, until };
}

// A gate the store's reads and writes pass: `hold` closes it from then on, returning a promise
// that resolves once one waits, and `release` to open it.
function createGate() {
  const gate = { entered: Promise.withResolvers<void>(), open: Promise.resolve() };

  function hold() {
    const open = Promise.withResolvers<void>();
    gate.entered = Promise.withResolvers<void>();
    gate.open = open.promise;
    return { entered: gate.entered.promise, release: () => open.resolve() };
  }

  async function pass() {
    gate.entered.resolve();
    await gate.open;
  }

  return { hold, pass };
}

// This peer, `me`, with 4 chunks of track 0 listed, the forwarders' ranges in `haves`, what each
// linked peer heard from it, and a store that takes chunks unless `refuse` names an error for one,
// and whose reads and writes wait while the gate is held.
function peer(haves: Record<string, number[]>) {
  const net = createNetwork();
  const { heard, hear, until } = createHearing();
  const { hold, pass } = createGate();
  const at = {
    held: new Map<string, Bytes>(),
    refuse: new Map<string, Error>(),
    heard,
    reads: [] as number[],
    full: 0,
  };
  const has = (key: string) => at.held.has(key);

  const links = createChunkLinks({
    plan: {
      source: "source",
      index: () => ({
        bounds: [0, 2, 4, 6, 8].map((s) => s * SECOND),
        bytes: [1, 2, 3, 4].map(() => CHUNK),
      }),
      ended: () => true,
      ratio: () => 1,
      missing: (track, from) => {
        let index = from;
        while (has(`media/${track}/${index}`)) index++;
        return index;
      },
      advertised: (_, from) => {
        const ahead = Object.values(haves).flatMap((indexes) => indexes.filter((i) => i >= from));
        return ahead.length === 0 ? undefined : Math.min(...ahead);
      },
      holders: ({ index }) => Object.keys(haves).filter((p) => haves[p]!.includes(index)),
      now: () => 0,
    },
    store: {
      put: async ({ key, sealed }: SealedObject) => {
        await pass();
        const error = at.refuse.get(key);
        if (error !== undefined) throw error;
        at.held.set(key, sealed);
        return true;
      },
      get: async ({ track, index }) => {
        at.reads.push(index);
        await pass();
        return at.held.get(`media/${track}/${index}`);
      },
      has: ({ track, index }) => has(`media/${track}/${index}`),
    },
    measures: (p) => (p === "source" ? FAR : FAST),
    room: (p) => (p === "bob" ? 2 : 0),
    full: () => at.full++,
  });

  // A link from `me` to `other`, connected; returns `other`'s end, whose messages and objects
  // `me` gets, and what `me` sends on it is heard as `other …`.
  function link(other: string, tag = other) {
    const [mine, theirs] = net.pair("me", other);
    theirs.on("message", (value) => hear(`${tag} ${spell(value)}`));
    theirs.on("object", (key) => hear(`${tag} deliver ${key}`));
    links.connect(mine);
    return theirs;
  }

  // Waits until the network is quiet, once the plan's pass, which runs in a microtask, has sent.
  async function quiet() {
    await Promise.resolve();
    await net.settle();
  }

  return { links, at, link, quiet, until, hold };
}

// A chunk message in a short spelling: `request 0:1 urgent`, `gone 0:5`.
function spell(value: unknown) {
  const message = checkChunkControl(value)!;
  const priority = message.type === "request" ? ` ${message.priority}` : "";
  return `${message.type} ${message.track}:${message.index}${priority}`;
}

// A peer delivering chunk `key` of track 0 to `me`.
const deliver = (from: Link, index: number) =>
  from.deliver(`media/0/${index}`, new Uint8Array([index]));

test("requests go on the newest link, a chunk delivered is stored, and one from elsewhere cancels", async () => {
  const p = peer({ fwd: [0, 1, 2, 3] });
  p.link("fwd", "old");
  const fwd = p.link("fwd", "new");
  p.links.plan.want(URGENT);
  await p.quiet();
  // The forwarder's room is 2; with the chunk advertised, the third waits for it, not the source.
  expect(p.at.heard).toEqual(["new request 0:0 urgent", "new request 0:1 urgent"]);

  deliver(fwd, 0);
  await p.quiet();
  expect([...p.at.held.keys()]).toEqual(["media/0/0"]);
  expect(p.at.heard.slice(2)).toEqual(["new request 0:2 urgent"]);

  // Chunk 1 comes from the source instead: its request to the forwarder is cancelled.
  const source = p.link("source");
  deliver(source, 1);
  await p.quiet();
  expect(p.at.heard.slice(3)).toEqual(["new cancel 0:1", "new request 0:3 urgent"]);
});

test("gone moves a chunk to the source, and busy holds a link until its next delivery", async () => {
  const p = peer({ fwd: [0, 1, 2, 3] });
  const fwd = p.link("fwd");
  p.link("source");
  p.links.plan.want(URGENT);
  await p.quiet();
  expect(p.at.heard).toEqual(["fwd request 0:0 urgent", "fwd request 0:1 urgent"]);

  fwd.send({ type: "gone", track: 0, index: 1 });
  await p.quiet();
  expect(p.at.heard.slice(2)).toEqual(["source request 0:1 urgent", "fwd request 0:2 urgent"]);

  fwd.send({ type: "busy", track: 0, index: 0 });
  await p.quiet();
  expect(p.at.heard).toHaveLength(4);
  deliver(fwd, 2);
  await p.quiet();
  // Room for 2 again: chunk 0, and chunk 3, which waited behind it.
  expect(p.at.heard.slice(4)).toEqual(["fwd request 0:0 urgent", "fwd request 0:3 urgent"]);
});

test("a peer heard from on a new link has room again after busy", async () => {
  const p = peer({ fwd: [0, 1, 2, 3] });
  const fwd = p.link("fwd");
  p.links.plan.want(URGENT);
  await p.quiet();
  fwd.send({ type: "busy", track: 0, index: 0 });
  await p.quiet();
  expect(p.at.heard).toHaveLength(2);
  p.link("fwd", "again");
  await p.quiet();
  expect(p.at.heard.slice(2)).toEqual(["again request 0:0 urgent"]);
});

test("a chunk that doesn't check out is gone from its sender, and one with no room stops fetching", async () => {
  const p = peer({ fwd: [0, 1, 2, 3] });
  const fwd = p.link("fwd");
  p.link("source");
  p.at.refuse.set("media/0/0", new InvalidChunkError("truncated header"));
  p.at.refuse.set("media/0/1", new DOMException("full", "QuotaExceededError"));
  p.links.plan.want(URGENT);
  await p.quiet();

  deliver(fwd, 0);
  await p.quiet();
  expect(p.at.heard.slice(2)).toEqual(["source request 0:0 urgent", "fwd request 0:2 urgent"]);

  // A busy forwarder's delivery, though not stored, gives it room again.
  fwd.send({ type: "busy", track: 0, index: 2 });
  deliver(fwd, 1);
  await p.quiet();
  expect(p.at.full).toBe(1);
  expect(p.at.heard).toHaveLength(4);
  // Once the consumer frees some, chunks 1 and 2 are asked for again, of the same forwarder.
  p.at.refuse.clear();
  p.links.plan.storage(false);
  await p.quiet();
  expect(p.at.heard.slice(4)).toEqual(["fwd request 0:1 urgent", "fwd request 0:2 urgent"]);
  expect(p.at.held.size).toBe(0);
});

test("a chunk the store fails to write otherwise is asked for again", async () => {
  const p = peer({ fwd: [0, 1, 2, 3] });
  const fwd = p.link("fwd");
  p.at.refuse.set("media/0/0", new DOMException("disk", "NotReadableError"));
  p.links.plan.want(URGENT);
  await p.quiet();
  deliver(fwd, 0);
  await p.quiet();
  expect(p.at.full).toBe(0);
  expect(p.at.heard.slice(2)).toEqual(["fwd request 0:0 urgent"]);
});

test("a closed link's requests go again on the peer's other link", async () => {
  const p = peer({ fwd: [0, 1, 2, 3] });
  p.link("fwd", "old");
  const fwd = p.link("fwd", "new");
  p.links.plan.want(URGENT);
  await p.quiet();
  fwd.close();
  await p.quiet();
  expect(p.at.heard).toEqual([
    "new request 0:0 urgent",
    "new request 0:1 urgent",
    "old request 0:0 urgent",
    "old request 0:1 urgent",
  ]);
});

test("a peer whose last link closed is asked nothing until it links again", async () => {
  const p = peer({});
  const source = p.link("source");
  p.links.plan.want(URGENT);
  await p.quiet();
  const asked = [0, 1, 2, 3].map((index) => `request 0:${index} urgent`);
  expect(p.at.heard).toEqual(asked.map((message) => `source ${message}`));
  source.close();
  await p.quiet();
  p.link("source", "again");
  await p.quiet();
  expect(p.at.heard.slice(4)).toEqual(asked.map((message) => `again ${message}`));
});

test("a chunk arriving is never the one an urgent chunk takes the place of", async () => {
  const p = peer({ fwd: [0, 1, 2, 3] });
  const fwd = p.link("fwd");
  p.links.plan.want({ tracks: [0], fromUs: 0, toUs: 4 * SECOND, priority: "background" });
  await p.quiet();
  expect(p.at.heard).toEqual(["fwd request 0:0 background", "fwd request 0:1 background"]);
  // Chunk 1 arrives and is being stored when chunk 2 turns urgent on the full link.
  const gate = p.hold();
  deliver(fwd, 1);
  await gate.entered;
  p.links.plan.want({ tracks: [0], fromUs: 4 * SECOND, toUs: 6 * SECOND, priority: "urgent" });
  await p.until(4);
  gate.release();
  await p.quiet();
  expect(p.at.heard.slice(2)).toEqual(["fwd cancel 0:0", "fwd request 0:2 urgent"]);
});

test("a closed link drops the requests that came on it", async () => {
  const p = peer({});
  for (const index of [5, 6, 7]) p.at.held.set(`media/0/${index}`, new Uint8Array([index]));
  const bob = p.link("bob");
  const gate = p.hold();
  bob.send({ type: "request", track: 0, index: 5, priority: "urgent" });
  bob.send({ type: "request", track: 0, index: 6, priority: "urgent" });
  await gate.entered;
  bob.close();
  await p.quiet();
  // Bob links again while chunk 5 is still read; only what it asks on the new link goes.
  const again = p.link("bob", "again");
  gate.release();
  again.send({ type: "request", track: 0, index: 7, priority: "urgent" });
  await p.until(1);
  expect(p.at.heard).toEqual(["again deliver media/0/7"]);
  expect(p.at.reads).toEqual([5, 7]);
});

test("other peers' requests are answered from the store, and other messages and objects ignored", async () => {
  const p = peer({});
  p.at.held.set("media/0/5", new Uint8Array([5]));
  const bob = p.link("bob");
  bob.send({ type: "request", track: 0, index: 5, priority: "urgent" });
  bob.send({ type: "request", track: 0, index: 7, priority: "urgent" });
  bob.send({ type: "chat-versions", versions: {} });
  bob.deliver("chat/x/1-2", new Uint8Array([1]));
  await p.quiet();
  expect(p.at.heard.toSorted()).toEqual(["bob deliver media/0/5", "bob gone 0:7"]);
  expect(p.at.held.size).toBe(1);
});

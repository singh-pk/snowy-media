// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Chunk request messages and the forwarder's side (src/chunk-requests.ts), in Chromium: only
// well-formed messages pass the check; a forwarder sends one chunk at a time on each link, the
// most urgent first and the oldest asked first; a repeat request moves up but keeps its place
// among its priority; it answers `busy` beyond the asker's room, `gone` for what it doesn't hold
// or can no longer read; and `cancel` and a closed link drop what waits.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import type { ChunkSlot } from "../src/chunk";
import { checkChunkControl, createChunkServer, type ChunkControl } from "../src/chunk-requests";

// A forwarder holding `held` of track 0, each asker's room in `room`, and what it does as events
// a test can wait for: `deliver a media/0/1`, `busy a 0:2`.
function forwarder(held: number[], room: Record<string, number>) {
  const events: string[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  // Each delivery on the wire, by key, to finish or fail, and the signal that stops it.
  const wire = new Map<string, PromiseWithResolvers<void> & { signal: AbortSignal }>();
  // Chunks that read back as evicted or throw, and each index read, in order.
  const at = { unreadable: new Set<number>(), broken: new Set<number>(), reads: [] as number[] };

  function record(event: string) {
    events.push(event);
    for (const waiter of waiters) if (events.length >= waiter.count) waiter.resolve();
  }

  const server = createChunkServer({
    room: (peer) => room[peer] ?? 0,
    holds: (slot) => slot.track === 0 && held.includes(slot.index),
    read: async ({ index }) => {
      at.reads.push(index);
      if (at.broken.has(index)) throw new DOMException("unreadable", "NotReadableError");
      return at.unreadable.has(index) ? undefined : new Uint8Array([index]);
    },
    send: (peer, message) => record(`${message.type} ${peer} ${message.track}:${message.index}`),
    deliver: (peer, key, _bytes, signal) => {
      const delivery = Promise.withResolvers<void>();
      wire.set(key, { ...delivery, signal });
      record(`deliver ${peer} ${key}`);
      return delivery.promise;
    },
  });

  // Resolves once `count` events have happened in all.
  function until(count: number) {
    const { promise, resolve } = Promise.withResolvers<void>();
    waiters.push({ count, resolve });
    if (events.length >= count) resolve();
    return promise;
  }

  // Asks for chunk `index` of track 0, round-tripped through JSON and checked as a link would.
  function ask(peer: string, index: number, priority: string) {
    const message = checkChunkControl(
      JSON.parse(JSON.stringify({ type: "request", track: 0, index, priority })),
    );
    server.requested(peer, message!);
  }

  return { server, events, until, wire, at, ask };
}

test("only well-formed chunk messages pass the check", () => {
  const slot: ChunkSlot = { track: 3, index: 0xffff_ffff };
  const good: ChunkControl[] = [
    { type: "request", track: 0, index: 0, priority: "urgent" },
    { type: "request", track: 0xffff, index: 7, priority: "background" },
    { type: "cancel", ...slot },
    { type: "busy", ...slot },
    { type: "gone", ...slot },
  ];
  for (const message of good) expect(checkChunkControl(message)).toEqual(message);
  // Fields beyond those a message has are left behind.
  expect(checkChunkControl({ type: "cancel", ...slot, priority: "urgent", extra: 1 })).toEqual({
    type: "cancel",
    ...slot,
  });

  const bad = [
    undefined,
    "request",
    { type: "request", track: 0, index: 0 },
    { type: "request", track: 0, index: 0, priority: "soon" },
    { type: "have", track: 0, index: 0 },
    { type: "cancel", track: 0x1_0000, index: 0 },
    { type: "cancel", track: 0, index: 0x1_0000_0000 },
    { type: "cancel", track: -1, index: 0 },
    { type: "cancel", track: 0, index: 1.5 },
    { type: "cancel", track: "0", index: 0 },
    { type: "cancel", track: 0 },
  ];
  for (const message of bad) expect(checkChunkControl(message)).toBeUndefined();
});

test("chunks go out one at a time, the most urgent first, then the oldest asked", async () => {
  const f = forwarder([0, 1, 2, 3], { a: 10 });
  f.ask("a", 0, "background");
  f.ask("a", 1, "ahead");
  f.ask("a", 2, "urgent");
  f.ask("a", 3, "ahead");
  await f.until(1);
  expect(f.events).toEqual(["deliver a media/0/0"]);

  for (const [count, key] of [
    [2, "media/0/0"],
    [3, "media/0/2"],
    [4, "media/0/1"],
  ] as const) {
    f.wire.get(key)!.resolve();
    await f.until(count);
  }

  expect(f.events).toEqual([
    "deliver a media/0/0",
    "deliver a media/0/2",
    "deliver a media/0/1",
    "deliver a media/0/3",
  ]);
});

test("a repeat request takes the newer priority and keeps the time it was first asked", async () => {
  const f = forwarder([0, 1, 2, 3], { a: 10 });
  f.ask("a", 0, "urgent");
  f.ask("a", 1, "background");
  f.ask("a", 2, "background");
  f.ask("a", 3, "background");
  // 3 moves ahead of 1 and 2; 1 asked again stays ahead of 2; 0 is on the wire already.
  f.ask("a", 3, "urgent");
  f.ask("a", 1, "background");
  f.ask("a", 0, "urgent");

  for (const [count, key] of [
    [2, "media/0/0"],
    [3, "media/0/3"],
    [4, "media/0/1"],
  ] as const) {
    await f.until(count - 1);
    f.wire.get(key)!.resolve();
  }

  await f.until(4);
  expect(f.events).toEqual([
    "deliver a media/0/0",
    "deliver a media/0/3",
    "deliver a media/0/1",
    "deliver a media/0/2",
  ]);
});

test("a request beyond the asker's room, the one on the wire counted, is answered busy", async () => {
  const f = forwarder([0, 1, 2], { a: 2 });
  f.ask("a", 0, "ahead");
  f.ask("a", 1, "ahead");
  f.ask("a", 2, "urgent");
  // No slot for b at all.
  f.ask("b", 0, "urgent");
  await f.until(3);
  // The busy answers go at once; the delivery waits for its read.
  expect(f.events).toEqual(["busy a 0:2", "busy b 0:0", "deliver a media/0/0"]);
});

test("once an asker's last request is answered, its room is free again", async () => {
  const f = forwarder([0, 1], { a: 1 });
  f.at.unreadable.add(0);
  f.ask("a", 0, "urgent");
  await f.until(1);
  f.ask("a", 1, "urgent");
  await f.until(2);
  expect(f.events).toEqual(["gone a 0:0", "deliver a media/0/1"]);
});

test("a chunk not held, evicted before its turn, or unreadable is answered gone", async () => {
  const f = forwarder([0, 1, 2], { a: 10 });
  f.at.unreadable.add(1);
  f.at.broken.add(2);
  f.ask("a", 5, "urgent");
  f.ask("a", 0, "urgent");
  f.ask("a", 1, "urgent");
  f.ask("a", 2, "urgent");
  await f.until(2);
  f.wire.get("media/0/0")!.resolve();
  await f.until(4);
  expect(f.events).toEqual(["gone a 0:5", "deliver a media/0/0", "gone a 0:1", "gone a 0:2"]);
});

test("cancel drops a waiting request, and stops the chunk on the wire", async () => {
  const f = forwarder([0, 1, 2], { a: 10 });
  f.ask("a", 0, "urgent");
  f.ask("a", 1, "urgent");
  f.ask("a", 2, "urgent");
  f.server.requested("a", { type: "cancel", track: 0, index: 1 });
  await f.until(1);
  const delivery = f.wire.get("media/0/0")!;
  expect(delivery.signal.aborted).toBe(false);
  f.server.requested("a", { type: "cancel", track: 0, index: 0 });
  expect(delivery.signal.aborted).toBe(true);
  // The delivery settles once it stops, and the next goes.
  delivery.resolve();
  await f.until(2);
  expect(f.events).toEqual(["deliver a media/0/0", "deliver a media/0/2"]);
});

test("a chunk cancelled while it is read is never sent, and takes no room", async () => {
  const f = forwarder([0, 1], { a: 1 });
  f.ask("a", 0, "urgent");
  f.server.requested("a", { type: "cancel", track: 0, index: 0 });
  // With room for one, the next request is taken while chunk 0's read settles; 0 asked again
  // once 1 is on the wire is beyond that room.
  f.ask("a", 1, "urgent");
  await f.until(1);
  f.ask("a", 0, "urgent");
  f.wire.get("media/0/1")!.resolve();
  await f.until(2);
  expect(f.events).toEqual(["deliver a media/0/1", "busy a 0:0"]);
  expect(f.at.reads).toEqual([0, 1]);
});

test("a chunk asked again after it was cancelled on the wire is sent again", async () => {
  const f = forwarder([0], { a: 2 });
  f.ask("a", 0, "urgent");
  f.server.requested("a", { type: "cancel", track: 0, index: 0 });
  f.ask("a", 0, "urgent");
  await f.until(1);
  expect(f.events).toEqual(["deliver a media/0/0"]);
  expect(f.at.reads).toEqual([0, 0]);
});

test("a failed delivery moves on to the next", async () => {
  const f = forwarder([0, 1], { a: 10 });
  f.ask("a", 0, "urgent");
  f.ask("a", 1, "urgent");
  await f.until(1);
  f.wire.get("media/0/0")!.reject(new Error("send failed"));
  await f.until(2);
  expect(f.events).toEqual(["deliver a media/0/0", "deliver a media/0/1"]);
});

test("a repeat request on a full link isn't answered busy", async () => {
  const f = forwarder([0, 1], { a: 2 });
  f.ask("a", 0, "ahead");
  f.ask("a", 1, "ahead");
  f.ask("a", 1, "urgent");
  f.ask("a", 0, "urgent");
  await f.until(1);
  f.wire.get("media/0/0")!.resolve();
  await f.until(2);
  expect(f.events).toEqual(["deliver a media/0/0", "deliver a media/0/1"]);
});

test("a closed link drops its requests, and a later one starts afresh", async () => {
  const f = forwarder([0, 1, 2], { a: 10, b: 10 });
  f.ask("a", 0, "urgent");
  f.ask("a", 1, "urgent");
  await f.until(1);
  f.server.closed("a");
  f.wire.get("media/0/0")!.resolve();
  // b's delivery comes after a's drain has seen its link closed.
  f.ask("b", 2, "urgent");
  await f.until(2);
  f.ask("a", 2, "urgent");
  await f.until(3);
  expect(f.events).toEqual(["deliver a media/0/0", "deliver b media/0/2", "deliver a media/0/2"]);
  // a's chunk 1 was never read once its link closed.
  expect(f.at.reads).toEqual([0, 2, 2]);
});

test("a link that closes while its chunk is read is sent nothing", async () => {
  const f = forwarder([0, 1], { a: 10, b: 10 });
  f.ask("a", 0, "urgent");
  f.server.closed("a");
  // A cancel from a peer with no requests changes nothing.
  f.server.requested("c", { type: "cancel", track: 0, index: 0 });
  f.ask("b", 1, "urgent");
  await f.until(1);
  expect(f.events).toEqual(["deliver b media/0/1"]);
  expect(f.at.reads).toEqual([0, 1]);
});

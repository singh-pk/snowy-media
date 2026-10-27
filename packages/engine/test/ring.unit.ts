// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The packet ring between two threads, in Chromium: every packet arrives intact and in order
// through a ring far smaller than the data, records wrap around its end, a packet larger than
// the ring arrives in pieces, and closing it stops a producer that is waiting for room.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { AV_NOPTS_VALUE, AV_PKT_FLAG_KEY } from "@snowy-media/ffmpeg/core";
import {
  createConsumer,
  createOutgoingPacket,
  createPlaceReader,
  createProducer,
  createRing,
  END,
  FAILED,
  KEY_FLAG,
  NO_TIMESTAMP,
  type OutgoingPacket,
  PART,
  type Place,
} from "../src/ring";
import { size } from "./support/ring-packets";

// A packet of stream 0 at time 0 with no bytes, but for `fields`.
const out = (fields: Partial<OutgoingPacket>) => ({ ...createOutgoingPacket(), ...fields });

function startProducer(ring: SharedArrayBuffer, count: number) {
  const worker = new Worker(new URL("support/ring-producer.js", import.meta.url), {
    type: "module",
  });
  const written = new Promise<number>((resolve) => {
    worker.addEventListener("message", (e: MessageEvent<number>) => resolve(e.data), {
      once: true,
    });
  });
  worker.postMessage({ ring, count });
  return { worker, written };
}

test("every packet arrives intact and in order", async () => {
  const count = 5000;
  const ring = createRing(4096);
  const consumer = createConsumer(ring);
  const { worker, written } = startProducer(ring, count);
  const wrong: string[] = [];
  let i = 0;

  for (;;) {
    const packet = consumer.peek();

    if (!packet) {
      await consumer.wait();
      continue;
    }

    if (packet.stream === END) break;
    const { data } = packet;
    const n = size(i);
    const intact = data.length === n && data.every((b, j) => b === ((i + j) & 255));
    const meta = packet.pts === BigInt(i) && packet.dts === BigInt(-i) && packet.flags === (i & 1);
    if (!intact || !meta || packet.duration !== n) wrong.push(`packet ${i}`);
    consumer.release();
    i++;
  }

  expect(wrong).toEqual([]);
  expect(i).toBe(count);
  const total = await written;
  expect(total).toBe(count);
  worker.terminate();
});

test("closing the ring stops a producer that waits for room, and ends the consumer", async () => {
  const ring = createRing(4096);
  const blocked = Promise.withResolvers<void>();
  const consumer = createConsumer(ring, blocked.resolve);
  consumer.watch();
  const { worker, written } = startProducer(ring, 1000);
  // Read nothing, so the producer fills the ring and waits for room, which the watch tells.
  await blocked.promise;
  expect(consumer.producerWaiting()).toBe(true);
  consumer.close();
  const total = await written;
  expect(total).toBeLessThan(1000);
  // A closed ring holds nothing: a peek finds no packet, release does nothing, wait returns.
  expect(consumer.peek()).toBeUndefined();
  consumer.release();
  await consumer.wait();
  expect(consumer.peek()).toBeUndefined();
  worker.terminate();
});

test("closing an empty ring ends the consumer's own wait for a packet", async () => {
  const consumer = createConsumer(createRing(4096));
  const state = { ended: false };

  async function waitForPacket() {
    await consumer.wait();
    state.ended = true;
  }

  const waiting = waitForPacket();
  // A message to this thread comes back as a task of its own, after any wait that ended at once.
  const { port1, port2 } = new MessageChannel();
  const echoed = new Promise((resolve) =>
    port1.addEventListener("message", resolve, { once: true }),
  );
  port1.start();
  port2.postMessage(undefined);
  await echoed;
  expect(state.ended).toBe(false);
  consumer.close();
  // A wait that never ends fails the file (tooling/run-unit.ts).
  await waiting;
  expect(state.ended).toBe(true);
});

test("a write to an empty ring wakes the waiting consumer", async () => {
  const ring = createRing(4096);
  const consumer = createConsumer(ring);
  const producer = createProducer(ring);
  const waiting = consumer.wait();
  // Two writes while it waits: the first takes the flag and notifies, the second does not.
  producer.write(out({ data: new Uint8Array(1), size: 1 }));
  producer.write(out({ pts: 1n, data: new Uint8Array(1), size: 1 }));
  // A wait that never ends fails the file (tooling/run-unit.ts).
  await waiting;
  expect(consumer.peek()?.pts).toBe(0n);
  // A wait with packets in the ring returns at once.
  await consumer.wait();
  consumer.close();
});

test("a watching consumer hears once for each watch that the producer's thread blocks", async () => {
  const ring = createRing(4096);
  const heard = { count: 0, next: Promise.withResolvers<void>() };

  const consumer = createConsumer(ring, () => {
    heard.count++;
    heard.next.resolve();
  });

  const producer = createProducer(ring);
  // Unwatched, a block is not told; watched, the first takes the watch, so the second is not
  // told either.
  producer.blocking();
  consumer.watch();
  producer.blocking();
  producer.blocking();
  await heard.next.promise;
  expect(heard.count).toBe(1);
  heard.next = Promise.withResolvers<void>();
  consumer.watch();
  producer.blocking();
  await heard.next.promise;
  expect(heard.count).toBe(2);
  consumer.close();
});

test("offer writes only what fits, and a waiting producer hears each release and the close", () => {
  const ring = createRing(256);
  const producer = createProducer(ring);
  const freed = { count: 0 };
  const consumer = createConsumer(
    ring,
    () => {},
    () => freed.count++,
  );
  const data = new Uint8Array(64);
  // A record of 64 bytes takes 96 with its header, and an END record 32: two of each fill the
  // 256 bytes.
  expect(producer.offer(out({ duration: 1, data, size: 64 }))).toBe(true);
  expect(producer.offer(out({ pts: 1n, dts: 1n, duration: 1, data, size: 64 }))).toBe(true);
  expect(producer.offer(out({ pts: 2n, dts: 2n, duration: 1, data, size: 64 }))).toBe(false);
  expect(producer.offerEnd()).toBe(true);
  expect(producer.offerEnd()).toBe(true);
  expect(producer.offerEnd()).toBe(false);
  consumer.release();
  expect(freed.count).toBe(0);
  producer.waitingForRoom(true);
  const seen = producer.bell();
  consumer.release();
  expect(freed.count).toBe(1);
  expect(producer.bell()).not.toBe(seen);
  // Returns at once, the consumer having moved on.
  producer.sleep(seen);
  expect(producer.closed()).toBe(false);
  consumer.close();
  expect(freed.count).toBe(2);
  expect(producer.closed()).toBe(true);
  expect(producer.offer(out({ duration: 1, data, size: 1 }))).toBe(false);
  expect(producer.offerEnd()).toBe(false);
});

test("a producer fails at once on a full ring, and the consumer reads FAILED after every packet", async () => {
  const ring = createRing(256);
  const producer = createProducer(ring);
  const consumer = createConsumer(ring);
  const data = new Uint8Array(64);
  // Two records of 64 bytes and two END records fill the 256 bytes.
  expect(producer.offer(out({ duration: 1, data, size: 64 }))).toBe(true);
  expect(producer.offer(out({ pts: 1n, dts: 1n, duration: 1, data, size: 64 }))).toBe(true);
  expect(producer.offerEnd()).toBe(true);
  expect(producer.offerEnd()).toBe(true);
  expect(producer.offerEnd()).toBe(false);
  producer.fail();
  const read: (number | undefined)[] = [];

  for (let packet = consumer.peek(); packet?.stream !== FAILED; packet = consumer.peek()) {
    read.push(packet?.stream);
    consumer.release();
  }

  expect(read).toEqual([0, 0, END, END]);
  // FAILED stays, whatever is released.
  consumer.release();
  expect(consumer.peek()?.stream).toBe(FAILED);
  await consumer.wait();
  consumer.close();
});

test("a failure wakes the consumer waiting on an empty ring", async () => {
  const ring = createRing(256);
  const consumer = createConsumer(ring);
  const waited = consumer.wait();
  createProducer(ring).fail();
  await waited;
  expect(consumer.peek()?.stream).toBe(FAILED);
  consumer.close();
});

test("the key flag and the unknown timestamp are FFmpeg's", () => {
  expect([KEY_FLAG, NO_TIMESTAMP]).toEqual([AV_PKT_FLAG_KEY, AV_NOPTS_VALUE]);
});

test("a capacity or duration the ring cannot hold is an error", () => {
  expect(() => createRing(3000)).toThrow(RangeError);
  expect(() => createRing(32)).toThrow(RangeError);
  expect(() => createRing(2 ** 30)).toThrow(RangeError);
  const producer = createProducer(createRing(64));
  const src = new Uint8Array(64);
  expect(() => producer.write(out({ duration: 2 ** 32 + 5, data: src, size: 0 }))).toThrow(
    RangeError,
  );
});

// Packet n of `length` bytes, byte i of it n + i, for a packet that fills more than one record.
const pattern = (n: number, length: number) => Uint8Array.from({ length }, (_, i) => (n + i) & 255);

test("a packet larger than the ring arrives whole, with other records between its pieces", () => {
  const ring = createRing(256);
  const producer = createProducer(ring);
  const consumer = createConsumer(ring);
  const big = pattern(1, 1000);
  const small = pattern(2, 8);
  const got: string[] = [];
  const offered = { small: false };
  // The length of the big packet each time it is peeked again before its release.
  const peekedAgain: (number | undefined)[] = [];

  // Offered until it is all in, a piece of 64 bytes at a time as room frees, with a small
  // record offered between its pieces, as the render worker hands frames back meanwhile.
  for (let rounds = 0; got.length < 2; rounds++) {
    if (rounds > 100) throw new Error("no progress");
    const done = producer.offer(
      out({
        stream: 5,
        flags: KEY_FLAG,
        pts: 7n,
        dts: 6n,
        duration: 3,
        data: big,
        size: big.length,
      }),
    );
    if (rounds === 1)
      offered.small = producer.offer(out({ stream: 9, data: small, size: small.length }));
    if (done) got.push("offered");

    for (let packet = consumer.peek(); packet; packet = consumer.peek()) {
      const { stream, flags, pts, dts, duration, data } = packet;
      const want = stream === 5 ? big : small;
      const intact = data.length === want.length && data.every((b, i) => b === want[i]);
      got.push(`${stream} ${flags} ${pts} ${dts} ${duration} ${intact}`);
      if (stream === 5) peekedAgain.push(consumer.peek()?.data.length);
      consumer.release();
    }
  }

  expect(offered.small).toBe(true);
  expect(got).toEqual(["9 0 0 0 0 true", "offered", "5 1 7 6 3 true"]);
  // Peeked again before it is released, it is the same packet.
  expect(peekedAgain).toEqual([big.length]);
  // Each piece is offered once: the ring is empty and the next packet starts afresh.
  expect(
    producer.offer(out({ stream: 5, pts: 8n, dts: 8n, duration: 3, data: big, size: 100 })),
  ).toBe(true);
  expect(consumer.peek()?.data).toEqual(big.subarray(0, 100));
  consumer.close();
});

test("one packet at a time goes in pieces, and smaller ones go between them", () => {
  const ring = createRing(256);
  const producer = createProducer(ring);
  const consumer = createConsumer(ring);
  const big = pattern(5, 1000);
  // Two pieces of 64 bytes, each 96 with its header, go; the rest waits for room.
  expect(producer.offer(out({ stream: 5, data: big, size: big.length }))).toBe(false);
  expect(() => producer.offer(out({ stream: 6, data: big, size: big.length }))).toThrow(RangeError);
  expect(producer.offer(out({ stream: 9, data: big, size: 8 }))).toBe(true);
  consumer.close();
});

test("a record read where it is comes out whole, across the ring's end and in pieces", () => {
  const ring = createRing(256);
  const producer = createProducer(ring);
  const consumer = createConsumer(ring);
  const { read } = createPlaceReader(ring);
  const place: Place = { start: 0, size: 0, part: 0 };
  const into = new Uint8Array(1000);

  // Three records of 64 bytes, read and freed, so the next starts 64 bytes before the end.
  for (let i = 0; i < 3; i++) {
    expect(producer.offer(out({ data: pattern(i, 8), size: 8 }))).toBe(true);
    consumer.peek();
    consumer.release();
  }

  const wraps = pattern(6, 96);
  expect(producer.offer(out({ stream: 4, pts: 2n, data: wraps, size: wraps.length }))).toBe(true);
  const packet = consumer.peekPlace(place);
  expect([packet?.stream, packet?.pts, packet?.data.length]).toEqual([4, 2n, 0]);
  expect([place.part, place.start + place.size > 256]).toEqual([PART.whole, true]);
  read(place, into, 0);
  expect(into.subarray(0, place.size)).toEqual(wraps);
  consumer.release();
  const big = pattern(7, 1000);
  const parts: number[] = [];
  let length = 0;

  for (let rounds = 0; parts.at(-1) !== PART.last; rounds++) {
    if (rounds > 100) throw new Error("no progress");
    producer.offer(out({ stream: 5, data: big, size: big.length }));

    for (let p = consumer.peekPlace(place); p; p = consumer.peekPlace(place)) {
      read(place, into, length);
      length += place.size;
      parts.push(place.part);
      consumer.release();
    }
  }

  expect(into.subarray(0, length)).toEqual(big);
  expect(new Set(parts.slice(0, -1))).toEqual(new Set([PART.piece]));
  expect(parts.length).toBeGreaterThan(2);
  consumer.close();
});

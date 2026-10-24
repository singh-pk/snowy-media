// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The packet ring between two threads, in Chromium: every packet arrives intact and in order
// through a ring far smaller than the data, records wrap around its end, and closing it
// stops a producer that is waiting for room. Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { AV_NOPTS_VALUE, AV_PKT_FLAG_KEY } from "@snowy-media/ffmpeg/core";
import {
  createConsumer,
  createProducer,
  createRing,
  END,
  KEY_FLAG,
  NO_TIMESTAMP,
} from "../src/ring";
import { size } from "./support/ring-packets";

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
  const waiting = consumer.wait();
  consumer.close();
  // A wait that never ends fails the file (tooling/run-unit.ts).
  await waiting;
});

test("a write to an empty ring wakes the waiting consumer", async () => {
  const ring = createRing(4096);
  const consumer = createConsumer(ring);
  const producer = createProducer(ring);
  const waiting = consumer.wait();
  // Two writes while it waits: the first takes the flag and notifies, the second does not.
  producer.write(0, 0, 0n, 0n, 0, new Uint8Array(1), 0, 1);
  producer.write(0, 0, 1n, 0n, 0, new Uint8Array(1), 0, 1);
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
  expect(producer.offer(0, 0, 0n, 0n, 1, data, 0, 64)).toBe(true);
  expect(producer.offer(0, 0, 1n, 1n, 1, data, 0, 64)).toBe(true);
  expect(producer.offer(0, 0, 2n, 2n, 1, data, 0, 64)).toBe(false);
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
  expect(producer.offer(0, 0, 0n, 0n, 1, data, 0, 1)).toBe(false);
  expect(producer.offerEnd()).toBe(false);
});

test("hasRoom says whether a record fits with room to spare", () => {
  const producer = createProducer(createRing(256));
  const data = new Uint8Array(64);
  // A record of 64 bytes takes 96 with its header: one leaves 160 bytes.
  expect(producer.hasRoom(64, 160)).toBe(true);
  expect(producer.hasRoom(64, 161)).toBe(false);
  expect(producer.offer(0, 0, 0n, 0n, 1, data, 0, 64)).toBe(true);
  expect(producer.hasRoom(64, 64)).toBe(true);
  expect(producer.hasRoom(64, 65)).toBe(false);
});

test("the key flag and the unknown timestamp are FFmpeg's", () => {
  expect([KEY_FLAG, NO_TIMESTAMP]).toEqual([AV_PKT_FLAG_KEY, AV_NOPTS_VALUE]);
});

test("a capacity, packet or duration the ring cannot hold is an error", () => {
  expect(() => createRing(3000)).toThrow(RangeError);
  const producer = createProducer(createRing(64));
  const src = new Uint8Array(64);
  expect(() => producer.write(0, 0, 0n, 0n, 0, src, 0, 64)).toThrow(RangeError);
  expect(() => producer.write(0, 0, 0n, 0n, 2 ** 32 + 5, src, 0, 0)).toThrow(RangeError);
});

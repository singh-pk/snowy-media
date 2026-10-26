// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// One side of the ring benchmark (run.ts), in a worker as in the engine. The producer writes
// `count` packets of `size` bytes, as fast as it can or one every `interval` ms, stamped with
// the time it wrote them; the consumer reads them as the render worker will, woken by the
// producer's notify, and reports how long they took and how late each wake-up was.

import { createConsumer, createOutgoingPacket, createProducer, END } from "../src/ring";

export type RingJob =
  | {
      role: "produce";
      ring: SharedArrayBuffer;
      size: number;
      count: number;
      interval: number;
    }
  | { role: "consume"; ring: SharedArrayBuffer };

export interface RingResult {
  /** From the first packet to the END record. */
  ms: number;
  /** For each packet the consumer waited for, from its write to the wake-up, sorted. */
  latencies: number[];
}

// Microseconds on a clock every worker of the page shares.
const now = () => Math.round((performance.timeOrigin + performance.now()) * 1000);

function produce({ ring, size, count, interval }: Extract<RingJob, { role: "produce" }>) {
  const producer = createProducer(ring);
  const packet = createOutgoingPacket(new Uint8Array(size));
  packet.size = size;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));

  for (let i = 0; i < count; i++) {
    // oxlint-disable-next-line repo/no-timers -- a producer at a set rate is what the bench measures
    if (interval) Atomics.wait(sleeper, 0, 0, interval);
    packet.pts = BigInt(now());
    producer.write(packet);
  }

  producer.end();
}

async function consume(ring: SharedArrayBuffer): Promise<RingResult> {
  const consumer = createConsumer(ring);
  const latencies: number[] = [];
  let start = 0;
  let woken = false;

  for (;;) {
    const packet = consumer.peek();

    if (!packet) {
      await consumer.wait();
      woken = true;
      continue;
    }

    if (packet.stream === END) break;
    start ||= performance.now();
    if (woken) latencies.push((now() - Number(packet.pts)) / 1000);
    woken = false;
    consumer.release();
  }

  return { ms: performance.now() - start, latencies: latencies.toSorted((a, b) => a - b) };
}

async function run(job: RingJob) {
  if (job.role === "produce") {
    produce(job);
  } else {
    const result = await consume(job.ring);
    self.postMessage(result);
  }
}

self.addEventListener("message", ({ data }: MessageEvent<RingJob>) => void run(data));

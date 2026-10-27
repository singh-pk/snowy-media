// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The PCM ring and its clock, in Chromium, one render quantum at a time as the AudioWorklet reads
// it: samples arrive intact across the ring's end and from a producer thread that blocks for
// room, the clock stops on an underrun and resumes with the audio, and closing the ring stops
// the producer, also while it waits. Once the audio is finished, or without any, the clock runs
// through silence as far as the video reaches. Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { createPcmConsumer, createPcmControl, createPcmProducer, createPcmRing } from "../src/pcm";

const RATE = 1000;
const QUANTUM = 128;
const quantum = () => [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];

// Stereo frames from `first`: channel 0 holds the frame number, channel 1 its negative.
function frames(first: number, count: number) {
  const out = new Float32Array(count * 2);

  for (let i = 0; i < count; i++) {
    out[2 * i] = first + i;
    out[2 * i + 1] = -(first + i);
  }

  return out;
}

test("frames arrive intact and in order across the end of the ring", () => {
  const ring = createPcmRing(256, 2, RATE);
  const producer = createPcmProducer(ring);
  const consumer = createPcmConsumer(ring);
  const wrong: number[] = [];
  // 100 frames first, so every later write and read of a quantum crosses the end of the ring.
  producer.write(frames(0, 100), 0, 100);
  consumer.read([new Float32Array(100), new Float32Array(100)], 0);

  for (let k = 0; k < 50; k++) {
    const first = 100 + k * QUANTUM;
    expect(producer.write(frames(first, QUANTUM), 0, QUANTUM)).toBe(true);
    const [left = new Float32Array(), right = new Float32Array()] = quantum();
    consumer.read([left, right], 0);

    for (let i = 0; i < QUANTUM; i++) {
      if (left[i] !== first + i || right[i] !== -(first + i)) wrong.push(k);
    }
  }

  expect(wrong).toEqual([]);
});

function startProducer(ring: SharedArrayBuffer, count: number) {
  const worker = new Worker(new URL("support/pcm-producer.js", import.meta.url), {
    type: "module",
  });
  const blocked = Promise.withResolvers<void>();
  const written = Promise.withResolvers<number>();
  // Wakes a wait for frames, on each message from the producer.
  const progress = { next: Promise.withResolvers<void>() };

  worker.addEventListener("message", ({ data }: MessageEvent<number | "blocked" | "wrote">) => {
    if (data === "blocked") blocked.resolve();
    if (typeof data === "number") written.resolve(data);
    progress.next.resolve();
    progress.next = Promise.withResolvers<void>();
  });

  worker.postMessage({ ring, count });
  const wrote = () => progress.next.promise;
  return { worker, blocked: blocked.promise, written: written.promise, wrote };
}

test("frames arrive intact from a producer thread that waits for room", async () => {
  const count = 20_000;
  const ring = createPcmRing(256, 2, RATE);
  const consumer = createPcmConsumer(ring);
  const { worker, written, wrote } = startProducer(ring, count);
  const output = quantum();
  const wrong: number[] = [];
  let next = 0;

  while (next < count) {
    // Taken before the read, so a write after it ends the wait below.
    const more = wrote();
    consumer.read(output, 0);
    const [left = new Float32Array(), right = new Float32Array()] = output;
    // A short read leaves silence after the last frame, and no frame is silent.
    let n = 0;
    while (n < QUANTUM && left[n] !== 0) n++;

    for (let i = 0; i < n; i++) {
      if (left[i] !== next + i + 1 || right[i] !== -(next + i + 1)) wrong.push(next + i);
    }

    next += n;
    if (n < QUANTUM) await more;
  }

  expect(wrong).toEqual([]);
  const total = await written;
  expect(total).toBe(count);
  worker.terminate();
});

test("closing the ring stops a producer that waits for room", async () => {
  const ring = createPcmRing(256, 2, RATE);
  const { worker, blocked, written } = startProducer(ring, 10_000);
  // Read nothing, so the producer fills the ring and waits for room.
  await blocked;
  createPcmControl(ring).close();
  const total = await written;
  expect(total).toBeLessThan(10_000);
  worker.terminate();
});

test("the clock stops on an underrun and resumes with the audio", () => {
  const ring = createPcmRing(1024, 2, RATE);
  const producer = createPcmProducer(ring);
  const consumer = createPcmConsumer(ring);
  const control = createPcmControl(ring);
  producer.start(10);
  producer.write(frames(0, 250), 0, 250);
  const output = quantum();

  // A full quantum: the clock runs, at the media time of the next frame.
  consumer.read(output, 0);
  expect(control.read()).toEqual({ pts: 10.128, time: 0.128, playing: true });
  expect(control.mediaTime(0.2)).toBeCloseTo(10.2, 12);

  // 122 frames, then silence: the clock stops after the last frame, at its context time, and
  // runs until then.
  consumer.read(output, 128);
  expect(control.read()).toEqual({ pts: 10.25, time: 0.25, playing: false });
  expect(output[0]?.[121]).toBe(249);
  expect(output[0]?.subarray(122).every((v) => v === 0)).toBe(true);
  expect(control.mediaTime(0.2)).toBeCloseTo(10.2, 12);
  expect(control.mediaTime(5)).toBe(10.25);

  // An empty ring: still stopped where the last frame played, and silent.
  consumer.read(output, 256);
  expect(control.read()).toEqual({ pts: 10.25, time: 0.25, playing: false });
  expect(output[1]?.every((v) => v === 0)).toBe(true);

  // The audio continues: so does the clock, from where it stopped.
  producer.write(frames(250, 250), 0, 250);
  consumer.read(output, 384);
  expect(control.read()).toEqual({ pts: 10.378, time: 0.512, playing: true });
  expect(output[0]?.[0]).toBe(250);
});

test("once the audio is finished, the clock runs through silence as far as the video reaches", () => {
  const ring = createPcmRing(1024, 2, RATE);
  const producer = createPcmProducer(ring);
  const consumer = createPcmConsumer(ring);
  const control = createPcmControl(ring);
  producer.start(10);
  producer.write(frames(0, 100), 0, 100);
  producer.finish();
  // Video to 10.3 s: 300 frames from the start.
  producer.reach(10.3);
  const output = quantum();

  // 100 frames of audio, then silence that counts as played.
  consumer.read(output, 0);
  expect(control.read()).toEqual({ pts: 10.128, time: 0.128, playing: true });
  expect(output[0]?.[99]).toBe(99);
  expect(output[0]?.subarray(100).every((v) => v === 0)).toBe(true);
  consumer.read(output, 128);
  expect(control.read()).toEqual({ pts: 10.256, time: 0.256, playing: true });

  // 44 frames more reach 10.3 s, where the clock stops.
  consumer.read(output, 256);
  expect(control.read()).toEqual({ pts: 10.3, time: 0.3, playing: false });
  consumer.read(output, 384);
  expect(control.read()).toEqual({ pts: 10.3, time: 0.3, playing: false });

  // Video demuxed further: the clock runs on from where it stopped.
  producer.reach(10.5);
  consumer.read(output, 512);
  expect(control.read()).toEqual({ pts: 10.428, time: 0.64, playing: true });
});

test("without audio, the clock waits until it is finished, and for the video's packets", () => {
  const ring = createPcmRing(1024, 2, RATE);
  const producer = createPcmProducer(ring);
  const consumer = createPcmConsumer(ring);
  const control = createPcmControl(ring);
  producer.start(10);
  producer.reach(10.1);
  const output = quantum();

  // Not finished, an empty ring is an underrun, however far the video reaches.
  consumer.read(output, 0);
  expect(control.read()).toEqual({ pts: 10, time: 0, playing: false });

  // Finished: as far as the video reaches, 100 frames, then stopped.
  producer.finish();
  consumer.read(output, 128);
  expect(control.read()).toEqual({ pts: 10.1, time: 0.228, playing: false });
  expect(output[1]?.every((v) => v === 0)).toBe(true);
  // A reach behind the last one changes nothing.
  producer.reach(10.05);
  consumer.read(output, 256);
  expect(control.read()).toEqual({ pts: 10.1, time: 0.228, playing: false });
});

test("a reach past 2^32 microseconds, in two halves, stops the clock where it says", () => {
  const ring = createPcmRing(1024, 2, RATE);
  const producer = createPcmProducer(ring);
  const consumer = createPcmConsumer(ring);
  const control = createPcmControl(ring);
  // 4300 s is past 2^32 µs (4294.97 s), so the low half has wrapped.
  producer.start(4300);
  producer.finish();
  producer.reach(4300.1);
  consumer.read(quantum(), 0);
  expect(control.read()).toEqual({ pts: 4300.1, time: 0.1, playing: false });
});

test("closing the ring stops the producer and silences the consumer", () => {
  const ring = createPcmRing(256, 2, RATE);
  const producer = createPcmProducer(ring);
  const consumer = createPcmConsumer(ring);
  producer.write(frames(0, 100), 0, 100);
  createPcmControl(ring).close();
  expect(producer.write(frames(100, 1), 0, 1)).toBe(false);
  const output = quantum();
  consumer.read(output, 0);
  expect(output[0]?.every((v) => v === 0)).toBe(true);
});

test("offer writes what fits, and the doorbell rings as room frees up for a waiting producer", () => {
  const ring = createPcmRing(256, 2, RATE);
  const producer = createPcmProducer(ring);
  const consumer = createPcmConsumer(ring);
  const control = createPcmControl(ring);
  expect(producer.offer(frames(0, 300), 0, 300)).toBe(256);
  expect(producer.offer(frames(256, 1), 0, 1)).toBe(0);
  // Read with no producer waiting, the doorbell stays quiet.
  const quiet = producer.bell();
  consumer.read(quantum(), 0);
  expect(producer.bell()).toBe(quiet);
  expect(producer.offer(frames(256, 1), 0, 1)).toBe(1);
  // Raised before the bell is read, as the media worker does, so the read after rings it.
  producer.waitingForRoom(true);
  const seen = producer.bell();
  consumer.read(quantum(), 0);
  expect(producer.bell()).not.toBe(seen);
  // Returns at once, the bell having moved.
  producer.sleep(seen);
  const woken = producer.bell();
  control.wakeProducer();
  expect(producer.bell()).not.toBe(woken);
  const closing = producer.bell();
  control.close();
  expect(producer.bell()).not.toBe(closing);
  expect(producer.offer(frames(0, 1), 0, 1)).toBe(-1);
});

test("a ring size that is not a power of two is an error", () => {
  expect(() => createPcmRing(1000, 2, RATE)).toThrow(RangeError);
});

test("what is heard comes from the output timestamp, carried forward while it runs", () => {
  const ring = createPcmRing(1024, 2, RATE);
  const producer = createPcmProducer(ring);
  const consumer = createPcmConsumer(ring);
  const control = createPcmControl(ring);
  producer.start(10);
  producer.write(frames(0, 1000), 0, 1000);
  // Rendered up to context time 0.128, which plays media time 10.128.
  consumer.read(quantum(), 0);

  // Context time 0.1 heard at 5000 ms: 50 ms later, 0.15 is heard, so media time 10.15.
  control.publishOutput(0.1, 5000, true);
  expect(control.heard(5050)).toBeCloseTo(10.15, 12);
  // Suspended: what is heard stays where the output stopped.
  control.publishOutput(0.1, 5000, false);
  expect(control.heard(9000)).toBeCloseTo(10.1, 12);
  // Held by a pause: that media time is heard, whatever the context time, and it does not run.
  control.publishOutput(0.3, 9000, true, 10.12);
  expect(control.heard(9500)).toBeCloseTo(10.12, 12);
  expect(control.outputRunning()).toBe(false);
});

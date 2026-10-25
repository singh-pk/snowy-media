// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Engine benchmarks in Chromium on a GPU (test/support/browsers.ts). Each run is a fresh
// browser; every number is the median of --runs runs, in milliseconds. Prints a
// Markdown table and, with --out, writes the JSON.
//
// Usage: bun run bench [--runs 5] [--out bench/results/name.json]

import { parseArgs } from "node:util";
import type { Page } from "playwright";
import { cpuTime, launch, PROFILE } from "../test/support/browsers";
import { ENTRY, MEDIA_WORKER, PAGE, RING_WORKER, serveEngine } from "../test/support/serve";

const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "5" },
    out: { type: "string" },
  },
});

type Timings = Record<string, number>;

// The 4K fixture a scrub goes through and play plays, and each of its frames' times, in seconds.
const SCRUB_4K = "scrub-4k-h264-aac.mp4";
const expected: Record<string, { video: { timeBase: string; pts: number[] } }> = await Bun.file(
  new URL("../test/fixtures/expected.json", import.meta.url),
).json();
const scrubbed = expected[SCRUB_4K];
if (!scrubbed) throw new Error(`no ${SCRUB_4K} in expected.json`);
const [num = 1, den = 1] = scrubbed.video.timeBase.split("/").map(Number);
const due = scrubbed.video.pts.map((pts) => (pts * num) / den);

// name -> what it measures, run in a fresh page with the engine at ENTRY.
const benchmarks: Record<string, (tab: Page) => Promise<Timings>> = {
  // createEngine until it resolves: the platform check, the render worker and a GPU device.
  // Cold is the first engine in the page, warm a second one once the worker script is cached.
  startup: (tab) =>
    tab.evaluate(async (entry) => {
      const engine: typeof import("../src/index") = await import(entry);

      async function time() {
        const start = performance.now();
        const started = await engine.createEngine({ canvas: document.createElement("canvas") });
        const ms = performance.now() - start;
        started.close();
        return ms;
      }

      const cold = await time();
      const warm = await time();
      return { cold, warm };
    }, ENTRY),
  // engine.open until it resolves, for files in the origin's private file system. First is the
  // first file in a new engine, including whatever is left of loading the FFmpeg core; long is a ten-minute MP4
  // after it.
  open: (tab) =>
    tab.evaluate(
      async ({ entry, page }) => {
        const engine: typeof import("../src/index") = await import(entry);
        const support: typeof import("../test/support/page") = await import(page);
        const started = await engine.createEngine({ canvas: document.createElement("canvas") });

        const dir = "/test/fixtures/";

        async function load(name: string) {
          const res = await fetch(dir + name);
          const blob = await res.blob();
          return support.fileHandle(name, blob);
        }

        async function time(handle: FileSystemFileHandle) {
          const start = performance.now();
          await started.open(handle);
          return performance.now() - start;
        }

        const [short, long] = await Promise.all([load("h264-aac.mp4"), load("sync-10min.mp4")]);
        const first = await time(short);
        const tenMinutes = await time(long);
        started.close();
        return { first, long: tenMinutes };
      },
      { entry: ENTRY, page: PAGE },
    ),
  // The packet ring between two workers (ring.worker.ts), at the engine's capacity: moving
  // 256 MiB in packets of 1 KiB, 64 KiB, 1 MiB and 4 MiB (in pieces), and how
  // late the consumer wakes up for a packet written every 2 ms (median and 99th percentile).
  ring: (tab) =>
    tab.evaluate(
      async ({ page, worker }) => {
        const { createRing, RING_CAPACITY }: typeof import("../test/support/page") = await import(
          page
        );
        const total = 256 << 20;

        async function run(size: number, count: number, interval: number) {
          const ring = createRing(RING_CAPACITY);
          const [consumer, producer] = [0, 1].map(() => new Worker(worker, { type: "module" }));
          const done = new Promise<import("./ring.worker").RingResult>((resolve) => {
            consumer?.addEventListener("message", (e) => resolve(e.data), { once: true });
          });
          const jobs: import("./ring.worker").RingJob[] = [
            { role: "consume", ring },
            { role: "produce", ring, size, count, interval },
          ];
          consumer?.postMessage(jobs[0]);
          producer?.postMessage(jobs[1]);
          const result = await done;
          consumer?.terminate();
          producer?.terminate();
          return result;
        }

        const timings: Record<string, number> = {};

        for (const [label, size] of [
          ["1 KiB", 1 << 10],
          ["64 KiB", 1 << 16],
          ["1 MiB", 1 << 20],
          ["4 MiB", 1 << 22],
        ] as const) {
          const { ms } = await run(size, total / size, 0);
          timings[`256 MiB in ${label}`] = ms;
        }

        const { latencies } = await run(1 << 10, 500, 2);
        const at = (q: number) => latencies[Math.floor(q * (latencies.length - 1))] ?? NaN;
        timings["wake p50"] = at(0.5);
        timings["wake p99"] = at(0.99);
        return timings;
      },
      { page: PAGE, worker: RING_WORKER },
    ),
  // The media worker decoding the ten-minute AAC track into the PCM ring, in stereo at 48 kHz
  // (the track's rate: no resampling) and at 44.1 kHz, while the page drains the ring in
  // large reads; until the worker replies.
  audio: (tab) =>
    tab.evaluate(
      async ({ page, worker }) => {
        const support: typeof import("../test/support/page") = await import(page);
        const media = support.startMedia(worker);
        const res = await fetch("/test/fixtures/sync-10min.mp4");
        const blob = await res.blob();
        const file = new File([blob], "sync-10min.mp4");
        const read = 1 << 20;
        const output = [new Float32Array(read), new Float32Array(read)];

        async function time(rate: number) {
          // Opened again each time: the previous run left the demuxer at the end.
          await media.request({ type: "open", file });
          const pcm = support.createPcmRing(1 << 22, 2, rate);
          const consumer = support.createPcmConsumer(pcm);
          const state = { decoding: true };

          // Stands in for the AudioWorklet, which reads on its own clock and waits for nothing:
          // draining on the worker's events instead stalls it on each refill, up to
          // 19 % slower.
          async function drain() {
            while (state.decoding) {
              consumer.read(output, 0);
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
          }

          const draining = drain();
          const start = performance.now();
          const ring = support.createRing(64);
          const audio = { stream: 1, pcm, preroll: 0 };
          await media.request({ type: "demux", ring, streams: [], from: 0, audio });
          const ms = performance.now() - start;
          state.decoding = false;
          await draining;
          return ms;
        }

        const native = await time(48_000);
        const resampled = await time(44_100);
        media.stop();
        return { "10 min at 48 kHz": native, "10 min at 44.1 kHz": resampled };
      },
      { page: PAGE, worker: MEDIA_WORKER },
    ),
  // A drag through a 4K file from its start to 9 s, with no keyframe on the way, at 2 s of it a
  // second whatever the display's refresh: engine.fastSeek on every animation frame, the screen
  // read on each. How far, in media time, the frame on screen is behind where the drag was on
  // the frame before (p50, p90), the canvas's read-back included; and from the last fastSeek
  // until it resolves, with the frame due at 9 s up.
  scrub: (tab) =>
    tab.evaluate(
      async ({ entry, page, file, times, speed, to }) => {
        const engine: typeof import("../src/index") = await import(entry);
        const support: typeof import("../test/support/page") = await import(page);
        const canvas = document.createElement("canvas");
        [canvas.width, canvas.height] = [320, 180];
        document.body.append(canvas);
        const player = await engine.createEngine({ canvas });
        const res = await fetch(`/test/fixtures/${file}`);
        const blob = await res.blob();
        const handle = await support.fileHandle(file, blob);
        await player.open(handle);
        await player.seek(0);
        const reader = new OffscreenCanvas(canvas.width, canvas.height).getContext("2d");
        if (!reader) throw new Error("no 2D context");
        const drag = { at: 0, scrub: Promise.resolve(), sent: 0 };
        const lags: number[] = [];
        const start = performance.now();

        while (drag.at < to) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const id = support.frameOnScreen(canvas, reader);
          const shown = times[id];
          if (shown === undefined) throw new Error(`frame ${id} read on screen`);
          if (drag.at > 0) lags.push((drag.at - shown) * 1000);
          drag.at = Math.min(to, ((performance.now() - start) / 1000) * speed);
          drag.scrub = player.fastSeek(drag.at);
          drag.sent = performance.now();
        }

        await drag.scrub;
        const settle = performance.now() - drag.sent;
        player.close();
        canvas.remove();
        const sorted = lags.toSorted((a, b) => a - b);
        const at = (p: number) => sorted[Math.floor(p * sorted.length)] ?? 0;
        return { "lag p50": at(0.5), "lag p90": at(0.9), settle };
      },
      { entry: ENTRY, page: PAGE, file: SCRUB_4K, times: due, speed: 2, to: 9 },
    ),
  // The same 4K file played from its start for 8 s, the screen read on every animation frame:
  // how late the frame on screen is for the time heard (engine.currentTime), past when the next
  // frame was due (p50, p90, p99, max), the canvas's read-back included. The first read is left out:
  // play prerolls video before the clock starts. And the CPU time of every browser process over
  // the time played, in cores (`cpu cores`). And how far the clock got in those 8 s
  // (`reached s`), short of 8 on a machine too slow for the file.
  play: (tab) =>
    tab.evaluate(
      async ({ entry, page, file, times, seconds }) => {
        const engine: typeof import("../src/index") = await import(entry);
        const support: typeof import("../test/support/page") = await import(page);
        const canvas = document.createElement("canvas");
        [canvas.width, canvas.height] = [320, 180];
        document.body.append(canvas);
        const player = await engine.createEngine({ canvas });
        const res = await fetch(`/test/fixtures/${file}`);
        const blob = await res.blob();
        const handle = await support.fileHandle(file, blob);
        await player.open(handle);
        await player.play();
        // Exposed by the runner.
        const used: unknown = Reflect.get(window, "cpuTime");
        if (typeof used !== "function") throw new Error("no cpuTime");
        const start = performance.now();
        const before: unknown = await used();
        const reads = await support.watchScreen(player, canvas, seconds * 1000);
        const after: unknown = await used();
        const cores = (Number(after) - Number(before)) / ((performance.now() - start) / 1000);
        await player.pause();
        player.close();
        canvas.remove();
        const heard = reads.at(-1)?.[0] ?? 0;
        // A machine too slow for the file is measured; one that never plays has nothing to measure.
        if (reads.length < 2 || heard <= 0) throw new Error(`did not play: ${reads.length} reads`);
        const lateness = reads.slice(1).map(([time, id]) => {
          if (times[id] === undefined) throw new Error(`frame ${id} read on screen`);
          return Math.max(0, time - (times[id + 1] ?? Infinity)) * 1000;
        });
        const sorted = lateness.toSorted((a, b) => a - b);
        const at = (p: number) => sorted[Math.floor(p * sorted.length)] ?? 0;
        return {
          "late p50": at(0.5),
          "late p90": at(0.9),
          "late p99": at(0.99),
          "late max": sorted.at(-1) ?? 0,
          "cpu cores": cores,
          "reached s": heard,
        };
      },
      { entry: ENTRY, page: PAGE, file: SCRUB_4K, times: due, seconds: 8 },
    ),
};

const runs = Number(args.runs);
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");

function median(xs: number[]) {
  const sorted = xs.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const server = await serveEngine("<!doctype html><title>bench</title>");
const measured: Record<string, Timings[]> = {};

for (let i = 0; i < runs; i++) {
  const browser = await launch();
  const tab = await browser.newPage();
  await tab.exposeFunction("cpuTime", () => cpuTime(browser));
  await tab.goto(server.url.href);
  // A user gesture, so audio may start for play.
  await tab.mouse.click(1, 1);

  for (const [bench, measure] of Object.entries(benchmarks)) {
    const timings = await measure(tab);
    (measured[bench] ??= []).push(timings);
  }

  await browser.close();
}

const results = Object.fromEntries(
  Object.entries(measured).map(([bench, all]) => {
    const keys = Object.keys(all[0] ?? {});
    return [bench, Object.fromEntries(keys.map((k) => [k, median(all.map((t) => t[k] ?? 0))]))];
  }),
);

await server.stop(true);

// Three significant digits, so a wake-up of microseconds shows; whole milliseconds from 100.
const format = (ms: number) => (ms >= 100 ? ms.toFixed(0) : ms.toPrecision(3));

// One row per benchmark and measurement.
const rows = Object.entries(results).flatMap(([bench, timings]) =>
  Object.entries(timings).map(([k, ms]) => `| ${bench} ${k} | ${format(ms)} |`),
);
console.log(`| ms, or as named (median of ${runs}) | Chromium${PROFILE ? `, ${PROFILE}` : ""} |`);
console.log("| --- | ---: |");
console.log(rows.join("\n"));

const json = { date: new Date().toISOString(), runs, results };
if (args.out) await Bun.write(args.out, `${JSON.stringify(json, null, 2)}\n`);

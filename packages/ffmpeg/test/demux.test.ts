// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Opens every fixture with the WASM core in Chromium, decodes its audio and video,
// and compares the result with native FFmpeg 9.0.2. Usage: bun test (after building dist/).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Browser, chromium } from "playwright";
import expected from "./fixtures/expected.json";
import { serve } from "../../../tooling/test-server";

const server = serve(new URL("../", import.meta.url), "<!doctype html><title>test</title>");
afterAll(() => server.stop(true));

// Float decoders differ from native FFmpeg in the last bits: native builds fuse multiply-adds
// and WebAssembly cannot. This bounds the difference per sample, in full scale.
const FLOAT_TOLERANCE = 1e-6;

interface Audio {
  frames: number;
  samples: number;
  firstPts: (string | null)[];
  sha256: string;
}

// Audio resampled by sny_resample: samples per channel and every PROBE_STRIDE-th value.
interface Resampled {
  samples: number;
  probe: string | number[];
}

interface Stream {
  [key: string]: unknown;
  audio?: Audio & { exact?: boolean; probe?: string | number[]; resampled?: Resampled };
  video?: { [key: string]: unknown; videoFrame?: string };
}

interface Result {
  [key: string]: unknown;
  streams?: Stream[];
}

const fixtures: Record<string, Result> = expected;
const names = Object.keys(fixtures);

describe("every fixture", () => {
  let browser: Browser;
  let isolated = false;
  let results: Record<string, Result> = {};
  let transferred: Record<string, Result> = {};

  beforeAll(async () => {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on("console", (m) => m.type() === "error" && console.error(m.text()));
    page.on("pageerror", (e) => console.error(e.message));
    await page.goto(server.url.href);
    isolated = await page.evaluate(() => crossOriginIsolated);
    const run = (url: string) =>
      page.evaluate(
        ({ worker: src, list }) =>
          new Promise<Record<string, Result>>((resolve) => {
            const worker = new Worker(src, { type: "module" });
            worker.addEventListener("message", (e) => resolve(e.data));
            worker.addEventListener("error", (e) => resolve({ worker: { error: e.message } }));
            worker.postMessage(list);
          }),
        { worker: url, list: names },
      );

    results = await run("/test/demux.worker.js");
    transferred = await run("/test/demux.worker.js?transfer");
  }, 120_000);
  afterAll(() => browser?.close());

  test("page is cross-origin isolated", () => expect(isolated).toBe(true));
  test("a decoder asking for more threads than the pool fails", () =>
    expect(results.threadPool as unknown).toBe("rejected"));
  test("a subtitle decoder refuses packets and frames", () =>
    expect(results.subtitleDecoder as unknown).toBe("rejected"));
  test("a flushed resampler starts afresh", () =>
    expect(results.resampleTwice as unknown).toBe("same"));

  for (const name of names) {
    test(name, () => {
      const { streams = [], ...rest } = results[name] ?? {};
      const { streams: want = [], ...wantRest } = fixtures[name] ?? {};
      expect(rest).toEqual({ ...wantRest, rewind: "ok" });
      expect(streams.map(withoutSamples)).toEqual(want.map(withoutSamples));

      // What withoutSamples leaves out, stream by stream, as native FFmpeg has it.
      for (const [i, w] of want.entries()) {
        const s = streams[i] ?? {};
        // Every decoded frame, converted, must be something WebCodecs can display.
        expect(s.video?.videoFrame).toBe(w.video ? "ok" : undefined);
        if (!w.audio) continue;

        if (!s.audio) throw new Error(`${name} stream ${i}: no audio`);
        expect(audioDiff(s.audio, w.audio)).toBeLessThanOrEqual(FLOAT_TOLERANCE);
        // Only some fixtures have native FFmpeg's resampled output (RESAMPLED in
        // scripts/gen-fixtures.ts).
        if (!w.audio.resampled) continue;

        expect(s.audio.resampled?.samples).toBe(w.audio.resampled.samples);
        const diff = probeDiff(s.audio.resampled?.probe ?? [], w.audio.resampled.probe);
        expect(diff).toBeLessThanOrEqual(FLOAT_TOLERANCE);
      }

      // Copying a stream to another module must not change a single sample.
      expect(transferred[name]).toEqual(results[name]);
    });
  }
});

// A stream with its decoded output reduced to what must match exactly: decoded video
// entirely, audio but for its float samples.
function withoutSamples({ audio, video, ...stream }: Stream): Stream {
  if (video) {
    const { videoFrame: _, ...v } = video;
    return { ...stream, video: v };
  }

  if (!audio) return stream;
  const { frames, samples, firstPts } = audio;
  return { ...stream, audio: { frames, samples, firstPts, sha256: "" } };
}

// The largest difference between decoded and native samples: 0 when the output is
// identical, Infinity when an integer decoder differs at all.
function audioDiff(actual: NonNullable<Stream["audio"]>, want: NonNullable<Stream["audio"]>) {
  if (actual.sha256 === want.sha256) return 0;

  if (want.exact || !actual.probe || !want.probe) return Number.POSITIVE_INFINITY;
  return probeDiff(actual.probe, want.probe);
}

// The largest difference between probed values and native FFmpeg's, base64 float32.
function probeDiff(actual: string | number[], want: string | number[]) {
  if (typeof want !== "string" || !Array.isArray(actual)) return Number.POSITIVE_INFINITY;
  const bytes = Buffer.from(want, "base64");
  const native = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  if (native.length !== actual.length) return Number.POSITIVE_INFINITY;
  let max = 0;

  for (const [i, v] of native.entries()) max = Math.max(max, Math.abs(v - (actual[i] ?? 0)));

  return max;
}

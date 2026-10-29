// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Audio and the clock in Chromium: the media worker decodes and resamples
// each fixture into the PCM ring, and the engine's AudioWorklet plays it into an
// OfflineAudioContext (test/support/page.ts). What plays equals native `ffmpeg -ar -ac`
// (test/fixtures/expected.json), the clock keeps to it without a gap and stops after its last
// frame, and over ten minutes every click still starts on its second. test/pcm.unit.ts
// covers underruns. Usage: bun run test.

import { afterAll, expect, test } from "bun:test";
import { PCM_RATE, SAMPLE_FRAMES } from "./support/audio";
import { launch } from "./support/browsers";
import { AUDIO_WORKLET, MEDIA_WORKER, PAGE, serveEngine } from "./support/serve";
import type * as PageSupport from "./support/page";
import type { Page } from "playwright";

interface Audio {
  id: number;
  clicks: number;
  resampled: { frames: number; probe: number[] };
}

const expected: Record<string, { audio?: Audio }> = await Bun.file(
  new URL("fixtures/expected.json", import.meta.url),
).json();
const LONG = "sync-10min.mp4";
// Float decoders and resamplers differ from native FFmpeg in the last bits: native builds
// fuse multiply-adds and WebAssembly cannot.
const FLOAT_TOLERANCE = 1e-6;
// How far from a whole second of media time a click may start: the fixtures' own bound.
const CLICK_TOLERANCE = 0.001;
const server = await serveEngine("<!doctype html><title>test</title>");

afterAll(() => server.stop(true));

type Played = Awaited<ReturnType<typeof PageSupport.play>>;

type Clip = Parameters<typeof PageSupport.play>[2]["clip"];

// Plays the audio of fixture `name` on `channels` channels, a second longer than it lasts, or
// than the clip `clip` of it does.
async function play(
  tab: Page,
  name: string,
  audio: Audio,
  { channels, clip }: { channels: number; clip?: Clip },
) {
  const { frames } = audio.resampled;
  const end = clip ? (clip.end - clip.start) / 1e6 : frames / PCM_RATE;
  const seconds = Math.ceil(end) + 1;

  return tab.evaluate(
    async ({ page, worker, worklet, n, s, options }) => {
      const support: typeof PageSupport = await import(page);
      const media = support.startMedia(worker);
      const res = await fetch(`/test/fixtures/${n}`);
      const blob = await res.blob();
      await media.request({ type: "open", file: new File([blob], n) });
      const played = await support.play(media, s, { worklet, ...options });
      media.stop();
      return played;
    },
    {
      page: PAGE,
      worker: MEDIA_WORKER,
      worklet: AUDIO_WORKLET,
      n: name,
      s: audio.id,
      options: { seconds, channels, frames, ...(clip ? { clip } : {}) },
    },
  );
}

// What every played fixture must show: while it plays, the clock is at the media time of
// what plays; it stops after the last frame, which is native FFmpeg's last; and each click
// starts on its whole second of media time.
function checkClock(name: string, played: Played, { clicks, resampled: { frames } }: Audio) {
  const { start } = played;
  // Constant while it plays: a gap, such as an underrun, would shift it.
  const shift = played.offsets.map((o) => Math.abs(o - start));
  // Sampled all the while it played: once every SAMPLE_FRAMES, give or take the ends.
  const samples = Math.ceil(frames / SAMPLE_FRAMES) - 1;
  expect(played.offsets.length, `${name} clock samples`).toBeGreaterThanOrEqual(samples);
  expect(Math.max(0, ...shift), `${name} clock shift`).toBeLessThan(1e-9);
  expect(played.end.playing, `${name} stopped at the end`).toBe(false);
  expect((played.end.pts - start) * PCM_RATE, `${name} frames played`).toBeCloseTo(frames, 6);
  expect(played.clicks.length, `${name} clicks`).toBe(clicks);
  const late = played.clicks.map((t, k) => Math.abs(t + start - k));
  expect(Math.max(...late), `${name} click timing`).toBeLessThanOrEqual(CLICK_TOLERANCE);
}

test("plays every fixture as ffmpeg -ar -ac resamples it", async () => {
  const browser = await launch();

  try {
    const tab = await browser.newPage();
    await tab.goto(server.url.href);

    // The long fixture has its own test below; a file without audio is in test/play.test.ts.
    const fixtures = Object.entries(expected).flatMap(([file, { audio }]) =>
      file !== LONG && audio ? [{ file, audio }] : [],
    );

    for (const { file, audio } of fixtures) {
      const played = await play(tab, file, audio, { channels: 2 });
      checkClock(file, played, audio);
      const want = audio.resampled.probe;
      const diff = Math.max(...want.map((v, i) => Math.abs(v - (played.probe[i] ?? Number.NaN))));
      expect(diff, `${file} samples`).toBeLessThanOrEqual(FLOAT_TOLERANCE);
    }
  } finally {
    await browser.close();
  }
}, 120_000);

test("the clock keeps time over ten minutes", async () => {
  const browser = await launch();

  try {
    const tab = await browser.newPage();
    await tab.goto(server.url.href);
    const { audio } = expected[LONG] ?? {};
    if (!audio) throw new Error(`no ${LONG} in expected.json`);
    // Mono, to halve the memory ten minutes take.
    const played = await play(tab, LONG, audio, { channels: 1 });
    checkClock(LONG, played, audio);
  } finally {
    await browser.close();
  }
}, 300_000);

// A clip of CLIP_FILE, read from 0.5 s to 1.9 s and placed 0.5 s later, on a composition that
// ends 0.6 s after it: in the file's time, its clock starts at -0.5 s, the composition's start,
// and runs on to 3 s, its end. Of the file's clicks, on its whole seconds, only the one at 1 s
// is in it.
const CLIP_FILE = "h264-aac.mp4";
const CLIP = { from: 500_000, start: -500_000, until: 1_900_000, end: 3_000_000 };

test("a clip's audio plays from its in point to its out point, in silence before and after", async () => {
  const browser = await launch();

  try {
    const tab = await browser.newPage();
    await tab.goto(server.url.href);
    const { audio } = expected[CLIP_FILE] ?? {};
    if (!audio) throw new Error(`no ${CLIP_FILE} in expected.json`);
    const played = await play(tab, CLIP_FILE, audio, { channels: 2, clip: CLIP });
    const shift = played.offsets.map((o) => Math.abs(o - played.start));
    // From the composition's start, without a gap, through the silence, to its end.
    expect(played.start).toBe(CLIP.start / 1e6);
    expect(Math.max(0, ...shift)).toBeLessThan(1e-9);
    expect(played.end.playing).toBe(false);
    expect(played.end.pts).toBeCloseTo(CLIP.end / 1e6, 6);
    // The one click in the clip, at its time in the file.
    expect(played.clicks.length).toBe(1);
    expect(Math.abs((played.clicks[0] ?? 0) + played.start - 1)).toBeLessThanOrEqual(
      CLICK_TOLERANCE,
    );
  } finally {
    await browser.close();
  }
}, 60_000);

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
import {
  AUDIO_WORKLET,
  MEDIA_WORKER,
  OFFLINE_AUDIO_PAGE,
  PAGE,
  serveEngine,
} from "./support/serve";
import type * as OfflineAudio from "./support/offline-audio";
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

type Played = Awaited<ReturnType<typeof OfflineAudio.play>>;

type Track = Omit<NonNullable<Parameters<typeof OfflineAudio.play>[2]["track"]>, "files" | "opens">;

// Plays the audio of fixture `name` on `channels` channels, a second longer than it lasts, or
// than the track `track` of it does, each of its layers read by a media worker of its own. With
// `stale`, each worker holds that fixture open first, as of an earlier open of a composition.
async function play(
  tab: Page,
  name: string,
  audio: Audio,
  { channels, track, stale }: { channels: number; track?: Track; stale?: string | undefined },
) {
  const { frames } = audio.resampled;
  const end = track ? (track.end - track.from) / 1e6 : frames / PCM_RATE;
  const seconds = Math.ceil(end) + 1;

  return tab.evaluate(
    async ({ page, offline, worker, worklet, n, s, held, options }) => {
      const support: typeof PageSupport = await import(page);
      const output: typeof OfflineAudio = await import(offline);
      const names = held ? [n, held] : [n];
      const responses = await Promise.all(names.map((each) => fetch(`/test/fixtures/${each}`)));
      const blobs = await Promise.all(responses.map((res) => res.blob()));
      const [file, first] = blobs.map((blob, i) => new File([blob], names[i] ?? ""));
      if (!file) throw new Error(`no ${n}`);
      const readers = Array.from({ length: 1 + (options.track?.layers?.length ?? 0) }, () =>
        support.startMedia(worker),
      );

      for (const reader of readers) {
        await reader.request({
          type: "open",
          file: first ?? file,
          asset: "",
          opens: held ? 1 : 0,
        });
      }

      const [media, ...more] = readers;
      if (!media) throw new Error("no media worker");
      const again = options.track && held && { ...options.track, files: { "": file }, opens: 2 };
      const read = again || options.track;
      const played = await output.play(media, s, {
        worklet,
        ...options,
        track: read,
        readers: more,
      });
      for (const reader of readers) reader.stop();
      return played;
    },
    {
      page: PAGE,
      offline: OFFLINE_AUDIO_PAGE,
      worker: MEDIA_WORKER,
      worklet: AUDIO_WORKLET,
      n: name,
      s: audio.id,
      held: stale ?? null,
      options: { seconds, channels, frames, ...(track ? { track } : {}) },
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

// Two clips of CLIP_FILE on a composition of 4 s, with silence before, between and after them:
// its 0.5 s to 1.5 s at 1 s, and its 1.8 s to 2.5 s at 2.5 s. Of the file's clicks, on its whole
// seconds, the one at 1 s plays at 1.5 s and the one at 2 s at 2.7 s; the one at 0 s, in neither
// clip, does not play.
const CLIP_FILE = "h264-aac.mp4";
const TRACK = {
  from: 0,
  clips: [
    { in: 500_000, out: 1_500_000, offset: 500_000 },
    { in: 1_800_000, out: 2_500_000, offset: 700_000 },
  ],
  end: 4_000_000,
};
const CLICKS = [1.5, 2.7];
// The first of them, mixed with a layer that plays the file's 1.2 s to 2.5 s from 1.8 s, over
// its end: the layer's click at 2 s plays at 2.6 s, and the clock runs on through both to 4 s.
const MIXED = {
  ...TRACK,
  clips: TRACK.clips.slice(0, 1),
  layers: [[{ in: 1_200_000, out: 2_500_000, offset: 600_000 }]],
};
const MIXED_CLICKS = [1.5, 2.6];
// The same played from 2 s: the first clip has ended, and the layer, cut to start there, still
// plays its click at 2.6 s.
const MIXED_FROM = { ...MIXED, from: 2_000_000 };
const LAYER_CLICKS = [2.6];

test("a track's clips play their audio at their places, in silence around them, mixed with a layer's, from any time and from a file opened again", async () => {
  const browser = await launch();

  try {
    const tab = await browser.newPage();
    await tab.goto(server.url.href);
    const { audio } = expected[CLIP_FILE] ?? {};
    if (!audio) throw new Error(`no ${CLIP_FILE} in expected.json`);

    for (const [track, clicks, stale] of [
      [TRACK, CLICKS],
      [MIXED, MIXED_CLICKS],
      [MIXED_FROM, LAYER_CLICKS],
      // Each media worker holds a file without audio from an earlier open, and opens the track's.
      [MIXED, MIXED_CLICKS, "no-audio-h264.mp4"],
    ] as const) {
      const played = await play(tab, CLIP_FILE, audio, { channels: 2, track, stale });
      const shift = played.offsets.map((o) => Math.abs(o - played.start));
      // From the composition's start, without a gap, through the silence, to its end.
      expect(played.start).toBe(track.from / 1e6);
      expect(Math.max(0, ...shift)).toBeLessThan(1e-9);
      expect(played.end.playing).toBe(false);
      expect(played.end.pts).toBeCloseTo(track.end / 1e6, 6);
      const late = played.clicks.map((t, k) => Math.abs(t + played.start - (clicks[k] ?? 0)));
      expect(played.clicks.length).toBe(clicks.length);
      expect(Math.max(...late)).toBeLessThanOrEqual(CLICK_TOLERANCE);
    }
  } finally {
    await browser.close();
  }
}, 60_000);

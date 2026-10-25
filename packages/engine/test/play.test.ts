// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// engine.play and engine.pause in Chromium, in real time, through the
// public API alone: while sync-10min.mp4 plays, the frame on the canvas is, at every animation
// frame, the one due at engine.currentTime, the media time being heard, within MAX_OFFSET; and
// a pause holds both the frame and the clock, on the frame due then or the one after
// (see the check). The canvas belongs to the render worker, so the
// page reads what it shows by drawing it. It plays for SNOWY_SYNC_SECONDS (default 20); the
// ten-minute run is `SNOWY_SYNC_SECONDS=600 bun test test/play.test.ts`. And play starts
// where video or audio gets no further, and goes on after a pause, with the frame due shown.
// Usage: bun run test.

import { afterAll, expect, test } from "bun:test";
import { PCM_RATE } from "./support/audio";
import { launch } from "./support/browsers";
import { ENTRY, PAGE, serveEngine } from "./support/serve";

interface Video {
  timeBase: string;
  width: number;
  height: number;
  pts: number[];
}

const FILE = "sync-10min.mp4";

const expected: Record<string, { video: Video; audio: { resampled: { frames: number } } }> =
  await Bun.file(new URL("fixtures/expected.json", import.meta.url)).json();
const video = expected[FILE]?.video ?? { timeBase: "1/1", width: 0, height: 0, pts: [] };
// Where play starts as video waits for packets, where it starts at the end of the audio, where
// it starts before the first frame, and the long one; each is played, paused and played on,
// for WATCH seconds a play.
const SPARSE = "sparse-h264-aac.mp4";
const STARTS = [SPARSE, "short-audio-h264-aac.mp4", "late-video-h264-aac.mp4", FILE];
const WATCH = 2;
// How far a play's clock at its last read may be from WATCH seconds on from where it started,
// in seconds: play resolves, and the watch begins, under 0.15 s after the clock starts.
const REAL_TIME = 0.25;
const SECONDS = Number(process.env.SNOWY_SYNC_SECONDS ?? 20);
// How far the frame on screen may be from the one due at the media time heard, in seconds.
const MAX_OFFSET = 0.02;
// On CI's runners, a virtual machine's GPU or software, Chromium does not draw in real time
// (on macOS its page gets 30 animation frames a second), so video falls behind: p99 82 ms on
// macOS, up to three quarters of a second at worst. There, the offsets are bounded by these, and logged; the
// bounds above hold on real hardware.
const CI_LATE = 1;
const CI_EARLY = 0.15;
const CI_P99 = 0.15;
// And over a two-second play, the clock may be as far off as a frame may be late.
const CI_REAL_TIME = CI_LATE;
const ci = process.env.CI === "true";
const realTime = ci ? CI_REAL_TIME : REAL_TIME;
// The bounds on a frame early and late, in seconds.
const earliness = ci ? CI_EARLY : MAX_OFFSET;
const lateness = ci ? CI_LATE : MAX_OFFSET;
const server = await serveEngine(
  `<!doctype html><title>test</title><canvas width="${video.width}" height="${video.height}"></canvas>`,
);

afterAll(() => server.stop(true));

// How far `time` is from the time frame `id` of `v` is due, in seconds: 0 while it is due,
// negative while it is early, positive once it is late. The first frame is due from the start,
// before its own time (docs/architecture.md#video-output).
function offset(v: Video, id: number, time: number) {
  const [num = 1, den = 1] = v.timeBase.split("/").map(Number);
  const due = id === 0 ? -Infinity : ((v.pts[id] ?? 0) * num) / den;
  const next = ((v.pts[id + 1] ?? Infinity) * num) / den;
  if (time < due) return time - due;
  return time >= next ? time - next : 0;
}

// Seconds as milliseconds to a tenth, for the log.
const ms = (x: number) => Math.round(x * 1e4) / 10;
// The reads of a play, for the log.
const span = (reads: [time: number, id: number][]) =>
  `${reads.length} reads, from ${reads[0]?.[0]} s to ${reads.at(-1)?.[0]} s`;

// The frame of `v` due at `time`.
function frameAt(v: Video, time: number) {
  const [num = 1, den = 1] = v.timeBase.split("/").map(Number);
  const after = v.pts.findIndex((pts) => (pts * num) / den > time);
  return (after < 0 ? v.pts.length : after) - 1;
}

// The reads of a play to check: all but the first, which may show a frame from five or more
// frames before, with the frame due on the next read under a millisecond later. That is no
// late frame: play prerolls a quarter second of video before the clock starts.
const fresh = (reads: [time: number, id: number][]) => reads.slice(1);

test(
  `plays ${FILE} with the frame on screen at the time heard`,
  async () => {
    const browser = await launch();

    try {
      const tab = await browser.newPage();
      await tab.goto(server.url.href);
      // A user gesture, so audio may start.
      await tab.mouse.click(1, 1);
      const got = await tab.evaluate(
        async ({ entry, page, file, seconds }) => {
          const engine: typeof import("../src/index") = await import(entry);
          const support: typeof import("./support/page") = await import(page);
          const canvas = document.querySelector("canvas");
          if (!canvas) throw new Error("no canvas");
          const player = await engine.createEngine({ canvas });
          const res = await fetch(`/test/fixtures/${file}`);
          const blob = await res.blob();
          const handle = await support.fileHandle(file, blob);
          await player.open(handle);
          await player.play();
          const playing = await support.watchScreen(player, canvas, seconds * 1000);
          await player.pause();
          // A frame for the render worker to see the pause, then a second paused.
          await support.watchScreen(player, canvas, 50);
          const paused = await support.watchScreen(player, canvas, 1000);
          player.close();
          return { playing, paused };
        },
        { entry: ENTRY, page: PAGE, file: FILE, seconds: SECONDS },
      );

      const checked = fresh(got.playing);
      const early = { offset: 0, time: 0, id: 0 };
      const late = { offset: 0, time: 0, id: 0 };

      for (const [time, id] of checked) {
        const o = offset(video, id, time);
        if (o < early.offset) Object.assign(early, { offset: o, time, id });
        if (o > late.offset) Object.assign(late, { offset: o, time, id });
      }

      const sorted = checked
        .map(([time, id]) => Math.abs(offset(video, id, time)))
        .toSorted((a, b) => a - b);
      const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
      const of = (w: typeof early) => `${w.offset} s, frame ${w.id} at ${w.time} s`;
      const p = (q: number) => ms(sorted[Math.floor(sorted.length * q)] ?? 0);
      // A summary for the log, so a failure on CI shows its shape.
      console.log(
        `${checked.length} reads;`,
        `|offset| p50 ${p(0.5)} p95 ${p(0.95)} p99 ${p(0.99)} ms;`,
        `early ${ms(early.offset)} ms at ${ms(early.time) / 1000} s;`,
        `late ${ms(late.offset)} ms at ${ms(late.time) / 1000} s;`,
        `over ${sorted.filter((x) => x >= MAX_OFFSET).length};`,
        `last ${ms(got.playing.at(-1)?.[0] ?? 0) / 1000} s`,
      );

      const last = got.playing.at(-1)?.[0] ?? 0;
      // It played in real time, from the start.
      expect(last).toBeGreaterThan(SECONDS - 1);
      // Watching ends on an animation frame, which may come late on CI.
      expect(last).toBeLessThan(SECONDS + 1);
      // No frame early, and none late.
      expect(-early.offset, `early by ${of(early)}`).toBeLessThan(earliness);
      const start = got.playing.slice(0, 8).map(([time, id]) => `${ms(time)}:${id}`);
      expect(late.offset, `late by ${of(late)}; first reads ${start.join(" ")}`).toBeLessThan(
        lateness,
      );
      expect(p99, "the 99th percentile").toBeLessThan(ci ? CI_P99 : MAX_OFFSET);
      // Paused: one time, one frame.
      expect(new Set(got.paused.map(([time]) => time)).size).toBe(1);
      expect(new Set(got.paused.map(([, id]) => id)).size).toBe(1);
      const [[pausedAt, pausedId] = [0, 0]] = got.paused;
      // The clock stopped where it was heard, not back at an older timestamp.
      expect(pausedAt, "the clock went back as it paused").toBeGreaterThanOrEqual(last);
      // The frame due then, or the one after: the last one shown was for a refresh later.
      expect([0, 1], `paused at ${pausedAt} on frame ${pausedId}`).toContain(
        pausedId - frameAt(video, pausedAt),
      );
    } finally {
      await browser.close();
    }
  },
  (SECONDS + 60) * 1000,
);

test(`starts, pauses and plays on ${STARTS.join(", ")}`, async () => {
  const browser = await launch();

  try {
    const tab = await browser.newPage();
    await tab.goto(server.url.href);
    await tab.mouse.click(1, 1);
    const got = await tab.evaluate(
      async ({ entry, page, files, seconds }) => {
        const engine: typeof import("../src/index") = await import(entry);
        const support: typeof import("./support/page") = await import(page);
        const canvas = document.querySelector("canvas");
        if (!canvas) throw new Error("no canvas");
        const player = await engine.createEngine({ canvas });
        const plays = [];

        for (const file of files) {
          const res = await fetch(`/test/fixtures/${file}`);
          const blob = await res.blob();
          const handle = await support.fileHandle(file, blob);
          await player.open(handle);
          await player.play();
          const first = await support.watchScreen(player, canvas, seconds * 1000);
          await player.pause();
          await support.watchScreen(player, canvas, 50);
          const paused = await support.watchScreen(player, canvas, 300);
          await player.play();
          const second = await support.watchScreen(player, canvas, seconds * 1000);
          plays.push({ first, paused, second });
        }

        player.close();
        return plays;
      },
      { entry: ENTRY, page: PAGE, files: STARTS, seconds: WATCH },
    );

    for (const [i, file] of STARTS.entries()) {
      const { video: v, audio } = expected[file] ?? {};
      const play = got[i];
      if (!v || !audio || !play) throw new Error(`no ${file}`);
      const end = audio.resampled.frames / PCM_RATE;
      const [[pausedAt, pausedId] = [0, 0]] = play.paused;
      console.log(`${file}: ${span(play.first)}; paused at ${pausedAt} s; ${span(play.second)}`);
      // Started, and played from the start in real time, up to the end of the audio.
      expect(Math.abs((play.first.at(-1)?.[0] ?? 0) - Math.min(end, WATCH))).toBeLessThan(realTime);
      // Paused: one time, one frame.
      expect(new Set(play.paused.map(([time]) => time)).size).toBe(1);
      expect(new Set(play.paused.map(([, id]) => id)).size).toBe(1);
      // Not back from the last read playing, and on the frame due then, or the one after, as
      // in the test above.
      expect(pausedAt, `${file} went back as it paused`).toBeGreaterThanOrEqual(
        play.first.at(-1)?.[0] ?? 0,
      );
      expect([0, 1], `${file} paused at ${pausedAt} on frame ${pausedId}`).toContain(
        pausedId - frameAt(v, pausedAt),
      );
      // Played on from where it paused.
      const resumed = play.second[0]?.[0] ?? 0;
      expect(resumed).toBeGreaterThanOrEqual(pausedAt);
      expect(resumed - pausedAt).toBeLessThan(realTime);
      expect(
        Math.abs((play.second.at(-1)?.[0] ?? 0) - Math.min(end, pausedAt + WATCH)),
      ).toBeLessThan(realTime);

      // Each frame due on screen as it plays.
      for (const [phase, reads] of Object.entries({ first: play.first, second: play.second })) {
        const checked = fresh(reads);

        for (const [time, id] of checked) {
          const o = offset(v, id, time);
          const at = `${file} ${phase}: frame ${id} at ${time} s`;
          expect(-o, at).toBeLessThan(earliness);
          expect(o, at).toBeLessThan(lateness);
        }
      }
    }
  } finally {
    await browser.close();
  }
}, 60_000);

// The decoder lets out sparse video's last frames only once it is flushed, at the END
// record, so the demuxer reads ahead of the audio to reach it before they are due.
test(`plays ${SPARSE} to the end with each frame on time`, async () => {
  const browser = await launch();

  try {
    const tab = await browser.newPage();
    await tab.goto(server.url.href);
    await tab.mouse.click(1, 1);
    const { video: v, audio } = expected[SPARSE] ?? {};
    if (!v || !audio) throw new Error(`no ${SPARSE}`);
    const end = audio.resampled.frames / PCM_RATE;
    const reads = await tab.evaluate(
      async ({ entry, page, file, watch }) => {
        const engine: typeof import("../src/index") = await import(entry);
        const support: typeof import("./support/page") = await import(page);
        const canvas = document.querySelector("canvas");
        if (!canvas) throw new Error("no canvas");
        const player = await engine.createEngine({ canvas });
        const res = await fetch(`/test/fixtures/${file}`);
        const blob = await res.blob();
        const handle = await support.fileHandle(file, blob);
        await player.open(handle);
        await player.play();
        const watched = await support.watchScreen(player, canvas, watch);
        player.close();
        return watched;
      },
      // Half a second past the end, so the last frame is read at the end.
      { entry: ENTRY, page: PAGE, file: SPARSE, watch: (end + 0.5) * 1000 },
    );

    console.log(`${SPARSE}: ${span(reads)}`);
    expect(Math.abs((reads.at(-1)?.[0] ?? 0) - end)).toBeLessThan(realTime);
    expect(reads.at(-1)?.[1]).toBe(v.pts.length - 1);

    for (const [time, id] of fresh(reads)) {
      const o = offset(v, id, time);
      expect(-o, `frame ${id} at ${time} s`).toBeLessThan(earliness);
      expect(o, `frame ${id} at ${time} s`).toBeLessThan(lateness);
    }
  } finally {
    await browser.close();
  }
}, 60_000);

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// engine.seek in Chromium, through the public API alone: paused, each seek
// puts up exactly the frame due at its target, the one FFmpeg's timestamps say, and the clock
// reads the target; a seek while playing plays on from there, with the frame due on screen;
// and a scrub, fastSeek on every animation frame, shows frames on the way, never past it, and
// plays on from where it is let go. An open clears the canvas.
// Each fixture takes SNOWY_SEEKS seeks (default 10) to the start, the end, frames' own times,
// between frames and at random; the gate is `SNOWY_SEEKS=50 bun test test/seek.test.ts`.
// Usage: bun run test.

import { afterAll, expect, test } from "bun:test";
import { decodable, inPage, SLOW_DRAWING } from "./support/browsers";
import { ENTRY, PAGE, serveEngine } from "./support/serve";
import type * as PageSupport from "./support/page";

interface Video {
  codec: string;
  timeBase: string;
  width: number;
  height: number;
  shown: [number, number];
  pts: number[];
  keyframes: number[];
}

const generated = await Bun.file(new URL("fixtures/expected.json", import.meta.url)).json();
const expected: Record<string, { video?: Video; audio?: unknown; duration: number }> =
  decodable(generated);
const SEEKS = Number(process.env.SNOWY_SEEKS ?? 10);
// The time a seek may take, in milliseconds, with the reads after it.
const SEEK_TIME = 1000;
// The long file, sought into while it plays.
const LONG = "sync-10min.mp4";
const PLAYING_AT = 300;
// The file scrubbed through, and for how many animation frames each way: from its start to
// SCRUB_TO s, through its keyframes, and back.
const SCRUBBED = "h264-aac.mp4";
const SCRUB_FRAMES = 90;
const SCRUB_TO = 2.9;
// Where the drag back ends, in seconds; and, after playing on from there and pausing, where a
// scrub goes back to, behind the clock, with no keyframe between.
const SCRUB_BACK = 0.5;
const SCRUB_AGAIN = 0.6;
// How long the screen is read after a seek, in milliseconds: a read may show the canvas as it
// was up to four frames before, so the last read is the one checked.
const SETTLE = 100;
// How far the clock may read from the target, in seconds: the audio starts on a whole sample.
const SAMPLE = 1e-4;
// How far the frame on screen may be from the one due at the clock while it plays, in seconds:
// a frame and more, or where Chromium draws slower than real time, the play test's bound there
// (test/play.test.ts).
const SYNC = SLOW_DRAWING ? 1 : 0.1;
const [width, height] = [320, 180];
const server = await serveEngine(
  `<!doctype html><title>test</title><canvas width="${width}" height="${height}"></canvas>`,
);

afterAll(() => server.stop(true));

// A frame's time in microseconds, rounded as the engine rounds it.
function micros(v: Video, pts: number) {
  const [num = 1, den = 1] = v.timeBase.split("/").map(Number);
  return Math.round((pts * num * 1e6) / den);
}

// A frame's time in seconds.
function seconds(v: Video, pts: number) {
  const [num = 1, den = 1] = v.timeBase.split("/").map(Number);
  return (pts * num) / den;
}

// The frame of `v` on screen after a seek to `target` microseconds: the latest due then, or
// the first before it is.
function frameAt(v: Video, target: number) {
  const after = v.pts.findIndex((pts) => micros(v, pts) > target);
  return Math.max(0, (after < 0 ? v.pts.length : after) - 1);
}

// Numbers in [0, 1) from `seed`, the same on every run (mulberry32).
function random(seed: number) {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 2 ** 32;
  };
}

// SEEKS targets in microseconds: the start, the end, a frame's time, halfway between two
// frames, back to the first frame, just before the last keyframe (where an open GOP's leading
// pictures are), and the rest at random, in an order that goes both ways.
function targets(v: Video, duration: number, seed: number) {
  const next = random(seed);
  const end = Math.round(duration * 1e6);
  const mid = Math.floor(v.pts.length / 2);
  const between = Math.floor((micros(v, v.pts[mid] ?? 0) + micros(v, v.pts[mid + 1] ?? 0)) / 2);
  const key = micros(v, v.keyframes.at(-1) ?? 0);
  const fixed = [0, end, micros(v, v.pts[mid] ?? 0), between, micros(v, v.pts[0] ?? 0)];
  if (key > 0) fixed.push(key - 1);
  const all = fixed.slice(0, SEEKS);
  while (all.length < SEEKS) all.push(Math.floor(next() * end));
  return all;
}

const fixtures = Object.entries(expected).filter(
  ([file, { video }]) =>
    video && file !== LONG && video.shown[0] === width && video.shown[1] === height,
);

test(
  `lands exactly on ${SEEKS} seeks in each of ${fixtures.length} files, paused`,
  async () => {
    const plan = fixtures.map(([file, { video, duration }], i) => ({
      file,
      targets: video ? targets(video, duration, i + 1) : [],
    }));
    const got = await inPage(server.url.href, (tab) =>
      tab.evaluate(
        async ({ entry, page, plan: files, settle }) => {
          const support: typeof PageSupport = await import(page);
          const { player, canvas } = await support.startEngine(entry);
          const all: { file: string; seen: [clock: number, id: number][] }[] = [];

          for (const { file, targets: times } of files) {
            const handle = await support.fixtureHandle(file);
            await player.open(handle);
            const seen: [number, number][] = [];

            for (const target of times) {
              await player.seek(target / 1e6);
              const reads = await support.watchScreen(player, canvas, settle);
              seen.push([player.currentTime, reads.at(-1)?.[1] ?? -1]);
            }

            all.push({ file, seen });
          }

          player.close();
          return all;
        },
        { entry: ENTRY, page: PAGE, plan, settle: SETTLE },
      ),
    );

    for (const [i, { file, targets: times }] of plan.entries()) {
      const v = expected[file]?.video;
      if (!v) throw new Error(`no video in ${file}`);
      const seen = got[i]?.seen ?? [];
      const frames = times.map((t) => frameAt(v, t));
      expect(
        seen.map(([, id]) => id),
        `${file} at ${times.join(", ")} µs`,
      ).toEqual(frames);

      // Without audio, the clock starts no earlier than the first frame.
      const first = expected[file]?.audio ? 0 : seconds(v, v.pts[0] ?? 0);

      for (const [k, t] of times.entries()) {
        const clock = seen[k]?.[0] ?? Number.NaN;
        expect(
          Math.abs(clock - Math.max(first, t / 1e6)),
          `${file}: clock at ${t} µs`,
        ).toBeLessThan(SAMPLE);
      }
    }
  },
  60_000 + SEEKS * fixtures.length * SEEK_TIME,
);

test(`plays on from a seek while ${LONG} plays`, async () => {
  const v = expected[LONG]?.video;
  if (!v) throw new Error(`no video in ${LONG}`);
  const reads = await inPage(
    server.url.href,
    (tab) =>
      tab.evaluate(
        async ({ entry, page, file, at }) => {
          const support: typeof PageSupport = await import(page);
          const { player, canvas } = await support.openEngine(entry, file);
          await player.play();
          await support.watchScreen(player, canvas, 500);
          await player.seek(at);
          const seen = await support.watchScreen(player, canvas, 2000);
          player.close();
          return seen;
        },
        { entry: ENTRY, page: PAGE, file: LONG, at: PLAYING_AT },
      ),
    { gesture: true },
  );

  const due = (id: number) => seconds(v, v.pts[id] ?? 0);
  // It plays on from the target, in real time.
  expect(reads[0]?.[0] ?? 0).toBeGreaterThanOrEqual(PLAYING_AT);
  expect(reads.at(-1)?.[0] ?? 0).toBeGreaterThan(PLAYING_AT + 1.5);
  // On a frame sought to, no further than a frame from the one due at the clock. The
  // play test bounds sync itself; this checks the seek lands in it.
  const newest = reads.at(-1);
  const id = newest?.[1] ?? 0;
  expect(Math.abs(due(id) - (newest?.[0] ?? 0))).toBeLessThan(SYNC);
}, 60_000);

test(`scrubs through ${SCRUBBED} and back, then plays on from where it is let go`, async () => {
  const v = expected[SCRUBBED]?.video;
  if (!v) throw new Error(`no video in ${SCRUBBED}`);
  const got = await inPage(
    server.url.href,
    (tab) =>
      tab.evaluate(
        async ({ entry, page, file, frames, to, back, again, settle }) => {
          const support: typeof PageSupport = await import(page);
          const { player, canvas } = await support.openEngine(entry, file);
          await player.seek(0);
          const forward = await support.drag(player, canvas, { from: 0, until: to, frames });
          const backward = await support.drag(player, canvas, { from: to, until: back, frames });
          const landed = await support.watchScreen(player, canvas, settle);
          await player.play();
          const playing = await support.watchScreen(player, canvas, 600);
          await player.pause();
          await player.fastSeek(again);
          const after = await support.watchScreen(player, canvas, settle);
          // And, played and paused again, a scrub just past the clock, short of the frame up.
          await player.play();
          await support.watchScreen(player, canvas, 300);
          await player.pause();
          const near = player.currentTime + 0.01;
          await player.fastSeek(near);
          const nearly = await support.watchScreen(player, canvas, settle);
          player.close();
          const [landedAt, againAt] = [landed.at(-1)?.[1] ?? -1, after.at(-1)?.[1] ?? -1];
          const nearAt = nearly.at(-1)?.[1] ?? -1;
          return { forward, backward, landed: landedAt, playing, again: againAt, near, nearAt };
        },
        {
          entry: ENTRY,
          page: PAGE,
          file: SCRUBBED,
          frames: SCRUB_FRAMES,
          to: SCRUB_TO,
          back: SCRUB_BACK,
          again: SCRUB_AGAIN,
          settle: SETTLE,
        },
      ),
    { gesture: true },
  );

  const due = (id: number) => seconds(v, v.pts[id] ?? 0);
  // Frames on the way, more than the keyframes passed, and none past the scrub either way:
  // forward, its clock starts up to a sample before its target; back, a frame lasts up to
  // the longest gap between two.
  const keys = v.keyframes.filter((k) => seconds(v, k) <= SCRUB_TO).length;
  const longest = Math.max(...v.pts.slice(1).map((pts, i) => pts - (v.pts[i] ?? 0)));
  expect(new Set(got.forward.map(([, id]) => id)).size).toBeGreaterThan(2 * keys);
  expect(new Set(got.backward.map(([, id]) => id)).size).toBeGreaterThan(2 * keys);

  for (const [time, id] of got.forward) {
    expect(due(id), `forward: frame ${id} at ${time} s`).toBeLessThanOrEqual(time + SAMPLE);
  }

  for (const [time, id] of got.backward) {
    expect(due(id), `back: frame ${id} at ${time} s`).toBeGreaterThanOrEqual(
      time - seconds(v, longest),
    );
  }

  // Exactly where it is let go, and it plays on from there, in sync.
  expect(got.landed).toBe(frameAt(v, Math.round(SCRUB_BACK * 1e6)));
  expect(got.playing[0]?.[0] ?? 0).toBeGreaterThanOrEqual(SCRUB_BACK - SAMPLE);
  expect(got.playing.at(-1)?.[0] ?? 0).toBeGreaterThan(SCRUB_BACK + 0.3);
  const last = got.playing.at(-1);
  expect(Math.abs(due(last?.[1] ?? 0) - (last?.[0] ?? 0))).toBeLessThan(SYNC);
  // Back behind where it paused, exactly.
  expect(got.again).toBe(frameAt(v, Math.round(SCRUB_AGAIN * 1e6)));
  expect(got.nearAt, `at ${got.near} s`).toBe(frameAt(v, Math.round(got.near * 1e6)));
}, 60_000);

// Nothing of a file stays on screen once another opens.
test("clears the canvas when another file opens", async () => {
  const v = expected[SCRUBBED]?.video;
  if (!v) throw new Error(`no video in ${SCRUBBED}`);
  const got = await inPage(server.url.href, (tab) =>
    tab.evaluate(
      async ({ entry, page, file, settle }) => {
        const support: typeof PageSupport = await import(page);
        const { player, canvas, handle } = await support.openEngine(entry, file);
        await player.seek(1);
        const shown = await support.watchScreen(player, canvas, settle);
        await player.open(handle);
        // On each animation frame until the canvas reads black: the render worker says
        // nothing when it has cleared. Without the clear, the test times out.
        const reader = new OffscreenCanvas(canvas.width, canvas.height).getContext("2d");
        if (!reader) throw new Error("no 2D context");
        const brightest = { value: -1 };

        while (brightest.value !== 0) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          reader.drawImage(canvas, 0, 0);
          const { data } = reader.getImageData(0, 0, canvas.width, canvas.height);
          brightest.value = data.reduce((max, c, i) => (i % 4 === 3 ? max : Math.max(max, c)), 0);
        }

        player.close();
        return { shown: shown.at(-1)?.[1] };
      },
      { entry: ENTRY, page: PAGE, file: SCRUBBED, settle: SETTLE },
    ),
  );

  expect(got.shown).toBe(frameAt(v, 1e6));
}, 60_000);

test("a seek after another file opens leaves it paused", async () => {
  const got = await inPage(
    server.url.href,
    (tab) =>
      tab.evaluate(
        async ({ entry, page, file, settle }) => {
          const support: typeof PageSupport = await import(page);
          const { player, canvas, handle } = await support.openEngine(entry, file);
          await player.play();
          await player.open(handle);
          await player.seek(1);
          const reads = await support.watchScreen(player, canvas, settle * 3);
          player.close();
          return reads.map(([time]) => time);
        },
        { entry: ENTRY, page: PAGE, file: LONG, settle: SETTLE },
      ),
    { gesture: true },
  );

  // The open stopped what played: the clock holds at the seek's target, never past it. Held
  // where the audio was heard, it may fall short of it by part of a sample (18 µs on CI's
  // software runners).
  expect(got.length).toBeGreaterThan(0);
  expect(Math.max(...got)).toBeLessThanOrEqual(1);
  expect(Math.min(...got)).toBeGreaterThanOrEqual(1 - SAMPLE);
}, 60_000);

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// engine.compose in Chromium, through the public API alone: a composition of one clip of
// h264-aac.mp4, read from 0.5 s and placed from 1 s to 3 s of 4 s. Played, the canvas is
// black before and after the clip and shows, within it, the frame due at the composition's
// time less the clip's offset, by native FFmpeg's timestamps, and the clock runs on to the end;
// paused, a seek lands on black or on that frame, with the clock at the target; an edit that
// moves the clip moves what is shown; and a plan the engine does not play is refused.
// Usage: bun run test

import { afterAll, expect, test } from "bun:test";
import { inPage, SLOW_DRAWING, SOFTWARE_GPU } from "./support/browsers";
import { ENTRY, PAGE, serveEngine } from "./support/serve";
import type * as PageSupport from "./support/page";
import type * as Engine from "../src/index";

interface Video {
  id: number;
  timeBase: string;
  pts: number[];
}

const FILE = "h264-aac.mp4";
const expected: Record<string, { video: Video; audio: { id: number; sampleRate: number } }> =
  await Bun.file(new URL("fixtures/expected.json", import.meta.url)).json();
const { video, audio } = expected[FILE] ?? { video: { id: 0, timeBase: "1/1", pts: [] } };
if (!audio) throw new Error(`no ${FILE} in expected.json`);
const [num = 1, den = 1] = video.timeBase.split("/").map(Number);
// The clip, in seconds: read from IN, placed from START to END of DURATION.
const [IN, START, END, DURATION] = [0.5, 1, 3, 4];
const OFFSET = START - IN;
// How late a frame may be, and how far the clock may be from where it should be, in seconds,
// as test/play.test.ts measured them: Chromium draws slower than real time on CI's macOS
// runners (SLOW_DRAWING) and in software on its Linux and Windows ones (SOFTWARE_GPU).
const LATE = SLOW_DRAWING ? 1 : SOFTWARE_GPU ? 0.05 : 0.02;
// How early a frame may be drawn, in seconds, by the same measures.
const EARLY = 0.02;
const REAL_TIME = SLOW_DRAWING ? 1 : 0.25;
// Seeks: in the gap before the clip, in it, and in the gap after it.
const SEEKS = [0.5, 1.7, 3.5];
// How far the clock may be from a seek's target, in seconds: the audio starts on a whole sample.
const SAMPLE = 1e-4;
// The fewest reads a second of watching may give (test/play.test.ts).
const MIN_READS = 10;
const server = await serveEngine(
  `<!doctype html><title>test</title><canvas width="320" height="180"></canvas>`,
);

afterAll(() => server.stop(true));

// The composition's plan of the clip placed from `start` seconds, in the plan's shape: as a
// timeline gives it, its picture and its sound are two clips, each in its stream's time base.
function planOf(start: number): Engine.Plan {
  const rate = audio?.sampleRate ?? 1;
  const layer = {
    start: start * 1e6,
    end: (start + END - START) * 1e6,
    speed: [1, 1] as Engine.Ratio,
    effects: [],
  };
  const v = {
    ...layer,
    clip: "v1",
    in: Math.round((IN * den) / num),
    timeBase: [num, den] as Engine.Ratio,
    source: { asset: FILE, stream: video.id },
    opacity: 1,
    blend: "normal",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  };
  const a = {
    ...layer,
    clip: "a1",
    in: Math.round(IN * rate),
    timeBase: [1, rate] as Engine.Ratio,
    source: { asset: FILE, stream: audio?.id ?? 1 },
    gainDb: 0,
    pan: 0,
    fadeIn: layer.start,
    fadeOut: layer.end,
  };
  return { segments: [{ from: 0, to: DURATION * 1e6, video: [v], audio: [a], transitions: [] }] };
}

// The frame due at file time `t`, in seconds, by native FFmpeg's timestamps.
function frameAt(t: number) {
  const after = video.pts.findIndex((pts) => (pts * num) / den > t);
  return Math.max(0, (after < 0 ? video.pts.length : after) - 1);
}

// What the canvas should show at composition time `t`: black (-1) outside the clip, or the
// frames that may be on screen, from the one due LATE before to the one due at `t`.
function shownAt(t: number) {
  if (t < START || t >= END) return [-1];
  const first = frameAt(Math.max(IN, t - LATE - OFFSET));
  const last = frameAt(t - OFFSET);
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

// Whether a read at `t` is far enough from the clip's edges to say which it shows: up to EARLY
// before an edge, a read may show what comes after it, and up to LATE after, what came before.
const clearOfEdges = (t: number) =>
  t < START - EARLY || (t >= START + LATE && t < END - EARLY) || t >= END + LATE;

// The plan with a second video layer over the clip, which the engine does not play.
function twoLayers(): Engine.Plan {
  const plan = planOf(START);
  const [segment] = plan.segments;
  const [layer] = segment?.video ?? [];
  if (segment && layer) segment.video.push({ ...layer, clip: "v2" });
  return plan;
}

test(`plays a clip of ${FILE} with black around it, to the end`, async () => {
  const reads = await inPage(
    server.url.href,
    (tab) =>
      tab.evaluate(
        async ({ entry, page, file, plan, duration, ms }) => {
          const support: typeof PageSupport = await import(page);
          const { player, canvas } = await support.startEngine(entry);
          const handle = await support.fixtureHandle(file);
          await player.compose({ duration, plan: () => plan, source: () => handle });
          await player.play();
          const seen = await support.watchScreen(player, canvas, ms, { black: true });
          player.close();
          return seen;
        },
        {
          entry: ENTRY,
          page: PAGE,
          file: FILE,
          plan: planOf(START),
          duration: DURATION * 1e6,
          ms: (DURATION + 0.5) * 1000,
        },
      ),
    { gesture: true },
  );

  console.log(`${reads.length} reads, from ${reads[0]?.[0]} s to ${reads.at(-1)?.[0]} s`);
  expect(reads.length).toBeGreaterThanOrEqual(Math.floor(MIN_READS * DURATION));
  // The clock ran on through the gap after the clip, to the end, and stopped there.
  expect(Math.abs((reads.at(-1)?.[0] ?? 0) - DURATION)).toBeLessThan(REAL_TIME);
  const checked = reads.slice(1).filter(([t]) => clearOfEdges(t));
  // Each part was seen: the gap before, the clip, the gap after.
  expect(checked.filter(([t]) => t < START).length).toBeGreaterThan(MIN_READS / 2);
  expect(checked.filter(([t]) => t > START && t < END).length).toBeGreaterThan(MIN_READS);
  expect(checked.filter(([t]) => t > END).length).toBeGreaterThan(MIN_READS / 2);

  for (const [t, id] of checked) expect(shownAt(t), `frame ${id} at ${t} s`).toContain(id);
}, 60_000);

test(`seeks into the gaps and the clip of ${FILE}, paused, and follows an edit`, async () => {
  const got = await inPage(server.url.href, (tab) =>
    tab.evaluate(
      async ({ entry, page, file, plan, moved, duration, seeks }) => {
        const support: typeof PageSupport = await import(page);
        const { player, canvas } = await support.startEngine(entry);
        const handle = await support.fixtureHandle(file);
        const current = { plan };
        await player.compose({ duration, plan: () => current.plan, source: () => handle });
        const seen: [number, number][] = [];

        for (const time of seeks) {
          await player.seek(time);
          // The last read of a short watch: a read may show the canvas a few frames before.
          const reads = await support.watchScreen(player, canvas, 100, { black: true });
          seen.push(reads.at(-1) ?? [Number.NaN, Number.NaN]);
        }

        // An edit moves the clip later: the time stays, and what is there now is shown.
        await player.seek(1.7);
        current.plan = moved;
        await player.changed();
        const edited = await support.watchScreen(player, canvas, 100, { black: true });
        seen.push(edited.at(-1) ?? [Number.NaN, Number.NaN]);
        player.close();
        return seen;
      },
      {
        entry: ENTRY,
        page: PAGE,
        file: FILE,
        plan: planOf(START),
        moved: planOf(2),
        duration: DURATION * 1e6,
        seeks: SEEKS,
      },
    ),
  );

  for (const [i, time] of SEEKS.entries()) {
    const [clock = Number.NaN, id] = got[i] ?? [];
    expect(Math.abs(clock - time), `clock at ${time} s`).toBeLessThan(SAMPLE);
    // Paused, the frame due at the target exactly, or black.
    const want = time < START || time >= END ? -1 : frameAt(time - OFFSET);
    expect(id, `at ${time} s`).toBe(want);
  }

  // Moved to start at 2 s, the clip leaves 1.7 s in the gap before it.
  const [clock = Number.NaN, id] = got[SEEKS.length] ?? [];
  expect(Math.abs(clock - 1.7)).toBeLessThan(SAMPLE);
  expect(id).toBe(-1);
}, 60_000);

// The plan with the clip's video layer reading its audio stream.
function wrongKind(): Engine.Plan {
  const plan = planOf(START);
  const layer = plan.segments[0]?.video[0];
  if (layer) layer.source = { asset: FILE, stream: audio?.id ?? 1 };
  return plan;
}

test("refuses what it does not play, follows edits that change nothing or only the length, and plays nothing black", async () => {
  const got = await inPage(server.url.href, (tab) =>
    tab.evaluate(
      async ({ entry, page, file, plan, two, kind, duration }) => {
        const support: typeof PageSupport = await import(page);
        const { player, canvas } = await support.startEngine(entry);
        const handle = await support.fixtureHandle(file);
        const source = () => handle;

        const outcome = async (each: Engine.Plan, length = duration) => {
          try {
            await player.compose({ duration: length, plan: () => each, source });
            return "composed";
          } catch (e) {
            return e instanceof Error ? e.name : String(e);
          }
        };

        const refused: string[] = [];

        for (const [each, length] of [[two], [plan, 0], [kind]] as const) {
          const name = await outcome(each, length);
          refused.push(name);
        }

        // A refusal leaves an open under way alone.
        const opening = outcome(plan);
        const meanwhile = await outcome(two);
        const opened = await opening;
        // An edit that changes nothing: the frame on screen stays.
        await player.seek(1.7);
        await player.changed();
        const unchanged = await support.watchScreen(player, canvas, 100, { black: true });
        // An edit that only lengthens it: a seek goes past the old end.
        const longer = { duration, plan: () => plan, source };
        await player.compose(longer);
        longer.duration = duration + 1_500_000;
        await player.changed();
        await player.seek(4.5);
        const lengthened = player.currentTime;
        // A composition of nothing: black, with the clock at the target.
        await outcome({ segments: [] });
        await player.seek(1);
        const empty = await support.watchScreen(player, canvas, 100, { black: true });
        player.close();
        const last = { unchanged: unchanged.at(-1), empty: empty.at(-1) };
        return { refused, meanwhile, opened, lengthened, ...last };
      },
      {
        entry: ENTRY,
        page: PAGE,
        file: FILE,
        plan: planOf(START),
        two: twoLayers(),
        kind: wrongKind(),
        duration: DURATION * 1e6,
      },
    ),
  );

  expect(got.refused).toEqual(["NotSupportedError", "RangeError", "RangeError"]);
  expect([got.meanwhile, got.opened]).toEqual(["NotSupportedError", "composed"]);
  expect(Math.abs(got.lengthened - 4.5)).toBeLessThan(SAMPLE);
  expect(got.unchanged?.[1]).toBe(frameAt(1.7 - OFFSET));
  expect(Math.abs((got.empty?.[0] ?? Number.NaN) - 1)).toBeLessThan(SAMPLE);
  expect(got.empty?.[1]).toBe(-1);
}, 60_000);

test(`follows an edit while it plays, and a pause made while it opens again`, async () => {
  const got = await inPage(
    server.url.href,
    (tab) =>
      tab.evaluate(
        async ({ entry, page, file, plan, moved, duration }) => {
          const support: typeof PageSupport = await import(page);
          const { player, canvas } = await support.startEngine(entry);
          const handle = await support.fixtureHandle(file);
          const current = { plan };
          await player.compose({ duration, plan: () => current.plan, source: () => handle });
          await player.play();
          await support.watchScreen(player, canvas, 300, { black: true });
          // Moved later while it plays: it opens again and plays on from where it was.
          current.plan = moved;
          await player.changed();
          const from = player.currentTime;
          const played = await support.watchScreen(player, canvas, 500, { black: true });
          // Moved back, with a pause right after: the pause holds once it has opened again.
          current.plan = plan;
          const edit = player.changed();
          await player.pause();
          await edit;
          const held = player.currentTime;
          await support.watchScreen(player, canvas, 300, { black: true });
          const after = player.currentTime;
          player.close();
          return { from, reads: played.length, to: played.at(-1)?.[0], held, after };
        },
        {
          entry: ENTRY,
          page: PAGE,
          file: FILE,
          plan: planOf(START),
          moved: planOf(2),
          duration: DURATION * 1e6,
        },
      ),
    { gesture: true },
  );

  expect(got.reads).toBeGreaterThanOrEqual(MIN_READS / 2);
  // It played on for the half second watched, as fast as real time.
  expect(Math.abs((got.to ?? Number.NaN) - got.from - 0.5)).toBeLessThan(REAL_TIME);
  expect(got.after).toBe(got.held);
}, 60_000);

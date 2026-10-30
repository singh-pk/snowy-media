// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// engine.compose in Chromium, through the public API alone: a composition of one clip of
// h264-aac.mp4, read from 0.5 s and placed from 1 s to 3 s of 4 s, and one of three clips cut back
// to back and with gaps, the middle one of vp9-opus.webm. Played, the canvas is black outside the
// clips and shows, within one, the frame due at the composition's time less the clip's offset,
// by native FFmpeg's timestamps, and the clock runs on to the end; paused, a seek lands on black
// or on that frame, with the clock at the target; an edit that moves the clip moves what is shown;
// and a plan the engine does not play is refused.
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
// Another container, codec and time base, so a clip read from the wrong file fails to decode.
const SECOND = "vp9-opus.webm";
const expected: Record<string, { video: Video; audio: { id: number; sampleRate: number } }> =
  await Bun.file(new URL("fixtures/expected.json", import.meta.url)).json();

// The video and audio streams of fixture `file`, by native FFmpeg.
function streamsOf(file = FILE) {
  const { video, audio } = expected[file] ?? {};
  if (!video || !audio) throw new Error(`no ${file} in expected.json`);
  const [num = 1, den = 1] = video.timeBase.split("/").map(Number);
  return { video, audio, num, den };
}

// The clip, in seconds: read from IN, placed from START to END of DURATION.
const [IN, START, END, DURATION] = [0.5, 1, 3, 4];
const OFFSET = START - IN;

interface Placed {
  in: number;
  start: number;
  end: number;
  // FILE without one.
  file?: string;
}

const CLIP: Placed = { in: IN, start: START, end: END };
// The sound alone of a clip over the end of CLIP and on after it, on a track of its own; after
// CLIP it shows black.
const SOUND: Placed = { in: 0.2, start: 2.5, end: 3.2 };
// And sound alone after CLIP, on its track.
const LAST_SOUND: Placed = { in: 1, start: 3.4, end: 3.8 };
// Three clips, each read from after a keyframe: the second, of SECOND, cut straight after the
// first, and the third after a gap.
// Each is longer than LATE, so some of it is clear of its edges on every runner.
const CUTS: Placed[] = [
  { in: 1.2, start: 0.5, end: 2.2 },
  { in: 0.1, start: 2.2, end: 3.9, file: SECOND },
  { in: 1.1, start: 4.4, end: 5.9 },
];
const CUT_DURATION = 6.4;
// Seeks into each gap, each clip, and just after the cut between two.
const CUT_SEEKS = [0.25, 1, 2.25, 4.1, 4.5, 6.1];
// How late a frame may be, and how far the clock may be from where it should be, in seconds,
// as test/play.test.ts measured them: Chromium draws slower than real time on CI's macOS
// runners (SLOW_DRAWING) and in software on its Linux and Windows ones (SOFTWARE_GPU).
const LATE = SLOW_DRAWING ? 1 : SOFTWARE_GPU ? 0.05 : 0.02;
// How early a frame may be drawn, in seconds: test/play.test.ts measured up to 15 ms in software.
const EARLY = 0.02;
const REAL_TIME = SLOW_DRAWING ? 1 : 0.25;
// Seeks: in the gap before the clip, in it, and in the gap after it, where LAST_SOUND plays.
const SEEKS = [0.5, 1.7, 3.5];
// How far the clock may be from a seek's target, in seconds: the audio starts on a whole sample.
const SAMPLE = 1e-4;
// The fewest reads a second of watching may give (test/play.test.ts).
const MIN_READS = 10;
const server = await serveEngine(
  `<!doctype html><title>test</title><canvas width="320" height="180"></canvas>`,
);

afterAll(() => server.stop(true));

// The composition's plan of `clips`, in the plan's shape: as a timeline gives it, each one's
// picture and sound are two clips, each in its stream's time base.
function planOf(clips: Placed[], duration = DURATION): Engine.Plan {
  const layers = clips.map((clip, i) => layersOf(clip, i));
  const to = Math.round(duration * 1e6);
  const [v, a] = [layers.map(([each]) => each), layers.map(([, each]) => each)];
  return { segments: [{ from: 0, to, video: v, audio: a, transitions: [] }] };
}

function layersOf(clip: Placed, i: number): [Engine.PlanVideoLayer, Engine.PlanAudioLayer] {
  const { file = FILE } = clip;
  const { video, audio, num, den } = streamsOf(file);
  const rate = audio.sampleRate;
  const layer = {
    start: Math.round(clip.start * 1e6),
    end: Math.round(clip.end * 1e6),
    speed: [1, 1] as Engine.Ratio,
    effects: [],
  };
  const v = {
    ...layer,
    clip: `v${i}`,
    in: Math.round((clip.in * den) / num),
    timeBase: [num, den] as Engine.Ratio,
    source: { asset: file, stream: video.id },
    opacity: 1,
    blend: "normal",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  };
  const a = {
    ...layer,
    clip: `a${i}`,
    in: Math.round(clip.in * rate),
    timeBase: [1, rate] as Engine.Ratio,
    source: { asset: file, stream: audio.id },
    gainDb: 0,
    pan: 0,
    fadeIn: layer.start,
    fadeOut: layer.end,
  };
  return [v, a];
}

const micros = (seconds: number) => Math.round(seconds * 1e6);

// The frame of `file` due at its time `t`, in seconds, by native FFmpeg's timestamps.
function frameAt(t: number, file?: string) {
  const { video, num, den } = streamsOf(file);
  const after = video.pts.findIndex((pts) => (pts * num) / den > t);
  return Math.max(0, (after < 0 ? video.pts.length : after) - 1);
}

// The clip of `clips` at composition time `t`, if any, and how much later than the file's it is.
function clipAt(t: number, clips: Placed[]) {
  const clip = clips.find((c) => t >= c.start && t < c.end);
  return clip && { ...clip, offset: clip.start - clip.in };
}

// What the canvas should show at composition time `t`: black (-1) outside the clips, or the
// frames that may be on screen, from the one due LATE before to the one due EARLY after `t`.
function shownAt(t: number, clips = [CLIP]) {
  const clip = clipAt(t, clips);
  if (!clip) return [-1];
  const first = frameAt(Math.max(clip.in, t - LATE - clip.offset), clip.file);
  const last = frameAt(t + EARLY - clip.offset, clip.file);
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

// Whether a read at `t` is far enough from the clips' edges to say which it shows: up to EARLY
// before an edge, a read may show what comes after it, and up to LATE after, what came before.
const clearOfEdges = (t: number, clips = [CLIP]) =>
  clips.every((c) => [c.start, c.end].every((edge) => t < edge - EARLY || t >= edge + LATE));

// The plan with a second video layer over the clip, which the engine does not play.
function twoLayers(): Engine.Plan {
  const plan = planOf([CLIP]);
  const [segment] = plan.segments;
  const [layer] = segment?.video ?? [];
  if (segment && layer) segment.video.push({ ...layer, clip: "v2" });
  return plan;
}

// The plan of CLIP, and the sound of SOUND and LAST_SOUND alone.
function withSound(): Engine.Plan {
  const plan = planOf([CLIP]);
  const [, sound] = layersOf(SOUND, 1);
  const [, last] = layersOf(LAST_SOUND, 2);
  plan.segments[0]?.audio.push(sound, last);
  return plan;
}

// Plays `plan` of `duration` seconds to its end, reading the screen as it goes.
function watchPlay(plan: Engine.Plan, duration: number) {
  return inPage(
    server.url.href,
    (tab) =>
      tab.evaluate(
        async ({ entry, page, each, length, ms }) => {
          const support: typeof PageSupport = await import(page);
          const { player, canvas } = await support.startEngine(entry);
          const source = (asset: string) => support.fixtureHandle(asset);
          await player.compose({ duration: length, plan: () => each, source });
          await player.play();
          const seen = await support.watchScreen(player, canvas, ms, { black: true });
          player.close();
          return seen;
        },
        {
          entry: ENTRY,
          page: PAGE,
          each: plan,
          length: Math.round(duration * 1e6),
          ms: (duration + 0.5) * 1000,
        },
      ),
    { gesture: true },
  );
}

// Checks the reads of a play of `clips` to `duration` seconds: the clock ran on to the end and
// stopped there, each clip was seen, and each read clear of an edge showed what it should.
// Returns those reads.
function checkPlay(reads: [number, number][], clips: Placed[], duration: number) {
  console.log(`${reads.length} reads, from ${reads[0]?.[0]} s to ${reads.at(-1)?.[0]} s`);
  expect(reads.length).toBeGreaterThanOrEqual(Math.floor(MIN_READS * duration));
  expect(Math.abs((reads.at(-1)?.[0] ?? 0) - duration)).toBeLessThan(REAL_TIME);
  const checked = reads.slice(1).filter(([t]) => clearOfEdges(t, clips));

  for (const { start, end } of clips) {
    const seen = checked.filter(([t]) => t > start && t < end).length;
    // MIN_READS a second, over the part of the clip clear of its edges.
    const least = Math.floor(MIN_READS * (end - start - EARLY - LATE));
    expect(seen, `reads from ${start} s to ${end} s`).toBeGreaterThanOrEqual(least);
  }

  for (const [t, id] of checked) expect(shownAt(t, clips), `frame ${id} at ${t} s`).toContain(id);
  return checked;
}

test(`plays a clip of ${FILE} with black around it, and sound alone over its end and after it, to the end`, async () => {
  const reads = await watchPlay(withSound(), DURATION);
  const checked = checkPlay(reads, [CLIP], DURATION);
  // The gaps before and after the clip were seen too.
  expect(checked.filter(([t]) => t < START).length).toBeGreaterThan(MIN_READS / 2);
  expect(checked.filter(([t]) => t > END).length).toBeGreaterThan(MIN_READS / 2);
}, 60_000);

test(`plays clips of ${FILE} and ${SECOND} cut back to back and after a gap, to the end`, async () => {
  const reads = await watchPlay(planOf(CUTS, CUT_DURATION), CUT_DURATION);
  checkPlay(reads, CUTS, CUT_DURATION);
}, 60_000);

// Seeks to each of `seeks` paused, in a composition of `plan` of `duration` seconds, and reads what
// each shows; then, given `moved`, seeks to 1.7 s, edits the plan to it and reads again.
function seekPaused(plan: Engine.Plan, duration: number, seeks: number[], moved?: Engine.Plan) {
  return inPage(server.url.href, (tab) =>
    tab.evaluate(
      async ({ entry, page, first, edit, length, targets }) => {
        const support: typeof PageSupport = await import(page);
        const { player, canvas } = await support.startEngine(entry);
        const source = (asset: string) => support.fixtureHandle(asset);
        const current = { plan: first };
        await player.compose({ duration: length, plan: () => current.plan, source });
        const seen: [number, number][] = [];

        for (const time of targets) {
          await player.seek(time);
          // The last read of a short watch: a read may show the canvas a few frames before.
          const reads = await support.watchScreen(player, canvas, 100, { black: true });
          seen.push(reads.at(-1) ?? [Number.NaN, Number.NaN]);
        }

        // An edit: the time stays, and what is there now is shown.
        if (edit) {
          await player.seek(1.7);
          current.plan = edit;
          await player.changed();
          const edited = await support.watchScreen(player, canvas, 100, { black: true });
          seen.push(edited.at(-1) ?? [Number.NaN, Number.NaN]);
        }

        player.close();
        return seen;
      },
      {
        entry: ENTRY,
        page: PAGE,
        first: plan,
        edit: moved ?? null,
        length: Math.round(duration * 1e6),
        targets: seeks,
      },
    ),
  );
}

// Paused, each seek of `seeks` landed on the frame of `clips` due at its target exactly, or black,
// with the clock at the target.
function checkSeeks(got: [number, number][], seeks: number[], clips: Placed[]) {
  for (const [i, time] of seeks.entries()) {
    const [clock = Number.NaN, id] = got[i] ?? [];
    expect(Math.abs(clock - time), `clock at ${time} s`).toBeLessThan(SAMPLE);
    const clip = clipAt(time, clips);
    // In whole microseconds, as the plan places it, so a target on a frame's time is due there.
    const due = clip ? frameAt((micros(time) - micros(clip.offset)) / 1e6, clip.file) : -1;
    expect(id, `at ${time} s`).toBe(due);
  }
}

test(`seeks into clips of ${FILE} and ${SECOND} and the gaps between them, paused`, async () => {
  const got = await seekPaused(planOf(CUTS, CUT_DURATION), CUT_DURATION, CUT_SEEKS);
  checkSeeks(got, CUT_SEEKS, CUTS);
}, 60_000);

test(`seeks into the gaps and the clip of ${FILE}, paused, with sound alone over them, and follows an edit`, async () => {
  const moved = planOf([{ in: IN, start: 2, end: 4 }]);
  const got = await seekPaused(withSound(), DURATION, SEEKS, moved);
  checkSeeks(got, SEEKS, [CLIP]);

  // Moved to start at 2 s, the clip leaves 1.7 s in the gap before it.
  const [clock = Number.NaN, id] = got[SEEKS.length] ?? [];
  expect(Math.abs(clock - 1.7)).toBeLessThan(SAMPLE);
  expect(id).toBe(-1);
}, 60_000);

// The plan with the clip's video layer reading its audio stream.
function wrongKind(): Engine.Plan {
  const plan = planOf([CLIP]);
  const layer = plan.segments[0]?.video[0];
  if (layer) layer.source = { asset: FILE, stream: streamsOf().audio.id };
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
        const last = { unchanged: unchanged.at(-1), reads: unchanged, empty: empty.at(-1) };
        return { refused, meanwhile, opened, lengthened, ...last };
      },
      {
        entry: ENTRY,
        page: PAGE,
        file: FILE,
        plan: planOf([CLIP]),
        two: twoLayers(),
        kind: wrongKind(),
        duration: DURATION * 1e6,
      },
    ),
  );

  expect(got.refused).toEqual(["NotSupportedError", "RangeError", "RangeError"]);
  expect([got.meanwhile, got.opened]).toEqual(["NotSupportedError", "composed"]);
  expect(Math.abs(got.lengthened - 4.5)).toBeLessThan(SAMPLE);
  const reads = got.reads.map(([t, id]) => `${t.toFixed(3)}:${id}`).join(" ");
  expect(got.unchanged?.[1], `reads ${reads}`).toBe(frameAt(1.7 - OFFSET));
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
          plan: planOf([CLIP]),
          moved: planOf([{ in: IN, start: 2, end: 4 }]),
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

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The render plan (src/plan.ts), in Chromium: a range cut into segments where the layers change,
// layers in compositing order, keyframes at their times on the timeline, and times in
// microseconds.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { plan } from "../src/plan";
import { FLICKS_PER_SECOND } from "../src/time";
import {
  asset,
  at,
  audio,
  clip,
  FRAME,
  id,
  innerSequence,
  SECOND,
  sequence,
  setUp,
  video,
  type Op,
} from "./support/project";

const MICROS = 1_000_000;

// A keyframe on a clip's opacity.
const opacity = (target: string, when: number, value: number) => ({
  op: "keyframe.set" as const,
  keyframe: { target, param: "video.opacity", at: when, value, ease: "linear" as const },
});

test("a storyline plays its clips one after another, in microseconds", () => {
  const { project, apply } = setUp();
  apply(clip({ anchor: at("a0") }), clip({ anchor: at("a1"), in: 24_000 }));
  const found = plan(project, sequence, 0, 2 * SECOND);
  expect(found?.sequence.rate).toEqual([24, 1]);
  expect(found?.segments.map(({ from, to }) => [from, to])).toEqual([
    [0, MICROS],
    [MICROS, 2 * MICROS],
  ]);
  expect(found?.segments[1]?.video).toEqual([
    {
      clip: id(2, 1),
      source: { asset, stream: 0 },
      in: 24_000,
      timeBase: [1, 24_000],
      start: MICROS,
      end: 2 * MICROS,
      speed: [1, 1],
      effects: [],
      opacity: 1,
      blend: "normal",
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    },
  ]);
  expect(found?.segments[1]?.audio).toEqual([]);
});

test("connected clips cut the range where they start and end, above the storyline", () => {
  const { project, apply } = setUp();
  apply(clip({ anchor: at("a0"), duration: 2 * SECOND }));
  const storyline = id(2, 0);
  apply(
    clip({ anchor: { clip: storyline, at: 12_000 }, duration: SECOND }),
    clip({
      anchor: { origin: sequence, at: SECOND },
      source: { asset, stream: 1 },
      role: audio,
      audio: { gainDb: -6, pan: 0.5, fadeIn: SECOND / 4, fadeOut: SECOND / 2 },
    }),
  );
  const found = plan(project, sequence, 0, 2 * SECOND);
  const layers = found?.segments.map(({ from, video: shown }) => [from, shown.map((l) => l.clip)]);
  expect(layers).toEqual([
    [0, [storyline]],
    [MICROS / 2, [storyline, id(3, 0)]],
    [MICROS, [storyline, id(3, 0)]],
    [1.5 * MICROS, [storyline]],
  ]);
  // A layer that plays on is the same object in the next segment.
  expect(found?.segments[1]?.video[1]).toBe(found?.segments[2]?.video[1]);
  const music = found?.segments[2]?.audio[0];
  expect(music?.clip).toBe(id(3, 1));
  expect(music?.bus).toBe(audio);
  expect(music?.timeBase).toEqual([1, 48_000]);
  expect([music?.gainDb, music?.pan, music?.fadeIn, music?.fadeOut]).toEqual([
    -6,
    0.5,
    1.25 * MICROS,
    1.5 * MICROS,
  ]);
});

test("video roles composite in order, each lane from the lowest up", () => {
  const { project, apply } = setUp();
  apply({
    op: "role.add",
    role: { sequence, name: "Titles", kind: "video", color: "#ffcc00", order: "a2" },
  });
  const titles = id(2, 0);
  const origin = { origin: sequence, at: 0 };
  apply(
    clip({ anchor: at("a0") }),
    clip({ anchor: origin, role: titles }),
    clip({ anchor: origin }),
    clip({ anchor: origin }),
  );
  const shown = plan(project, sequence, 0, SECOND)?.segments[0]?.video.map((l) => l.clip);
  expect(shown).toEqual([id(3, 0), id(3, 2), id(3, 3), id(3, 1)]);
});

test("keyframes are at their times on the timeline, in time order at any speed", () => {
  const { project, apply } = setUp();
  apply(
    clip({ anchor: at("a0"), in: 24_000, speed: [2, 1] }),
    clip({ anchor: at("a1"), in: 48_000, speed: [-1, 1] }),
  );
  const forwards = id(2, 0);
  const backwards = id(2, 1);
  apply(
    opacity(forwards, 48_000, 0),
    {
      op: "effect.add",
      effect: {
        clip: forwards,
        kind: "color.wheels",
        position: "a0",
        enabled: true,
        params: { amount: 1 },
      },
    },
    {
      op: "effect.add",
      effect: { clip: forwards, kind: "blur", position: "a1", enabled: false, params: {} },
    },
    opacity(backwards, 24_000, 0),
    opacity(backwards, 36_000, 1),
  );
  apply({
    op: "keyframe.set",
    keyframe: { target: id(3, 1), param: "amount", at: 72_000, value: 0.5, ease: "hold" },
  });
  const found = plan(project, sequence, 0, 2 * SECOND);
  const [first] = found?.segments[0]?.video ?? [];
  expect(first?.opacity).toEqual({ keyframes: [{ at: MICROS / 2, value: 0, ease: "linear" }] });
  expect(first?.effects).toEqual([
    {
      id: id(3, 1),
      kind: "color.wheels",
      params: { amount: { keyframes: [{ at: MICROS, value: 0.5, ease: "hold" }] } },
    },
  ]);
  const [second] = found?.segments[1]?.video ?? [];
  expect(second?.opacity).toEqual({
    keyframes: [
      { at: 1.5 * MICROS, value: 1, ease: "linear" },
      { at: 2 * MICROS, value: 0, ease: "linear" },
    ],
  });
});

test("generators and compound clips play in flicks, with their parameters animated", () => {
  const { project, apply } = setUp();
  apply({
    op: "sequence.add",
    sequence: { name: "Inner", rate: [24, 1], width: 1280, height: 720, sampleRate: 48_000 },
  });
  const inner = id(2, 0);
  apply(
    clip({ anchor: at("a0"), source: { generator: "solid", params: { level: 1 } }, in: 0 }),
    clip({ anchor: at("a1"), source: { sequence: inner }, in: 0 }),
  );
  apply({
    op: "keyframe.set",
    keyframe: { target: id(3, 0), param: "source.params.level", at: 0, value: 0, ease: "linear" },
  });
  const found = plan(project, sequence, 0, 2 * SECOND);
  const [solid] = found?.segments[0]?.video ?? [];
  expect(solid?.timeBase).toEqual([1, FLICKS_PER_SECOND]);
  expect(solid?.source).toEqual({
    generator: "solid",
    params: { level: { keyframes: [{ at: 0, value: 0, ease: "linear" }] } },
  });
  expect(found?.segments[1]?.video[0]?.source).toEqual({ sequence: inner });
});

test("a connected clip whose clip is removed plays where that clip was", () => {
  const { project, apply } = setUp();
  apply(clip({ anchor: at("a0") }), clip({ anchor: at("a1") }));
  apply(clip({ anchor: { clip: id(2, 1), at: 0 } }));
  apply({ op: "item.remove", id: id(2, 0) });
  const found = plan(project, sequence, 0, SECOND);
  expect(found?.segments[0]?.video.map((l) => l.clip)).toEqual([id(2, 1), id(3, 0)]);
});

test("a range part way through a clip keeps the clip's start, and names what starts at its end", () => {
  const { project, apply } = setUp();
  apply(
    clip({ anchor: at("a0") }),
    clip({ anchor: at("a1"), enabled: false }),
    clip({ anchor: at("a2") }),
    clip({ anchor: { origin: sequence, at: SECOND / 2 }, duration: 0 }),
  );
  const found = plan(project, sequence, SECOND / 2, SECOND);
  expect(found?.segments).toHaveLength(1);
  expect(found?.segments[0]?.from).toBe(MICROS / 2);
  expect(found?.segments[0]?.video.map((l) => [l.clip, l.start])).toEqual([[id(2, 0), 0]]);
  expect(found?.next).toEqual([]);
  // The disabled clip plays nothing, and the next one starts after it.
  expect(plan(project, sequence, SECOND, 2 * SECOND)?.segments[0]?.video).toEqual([]);
  const ahead = plan(project, sequence, SECOND, 2 * SECOND)?.next;
  expect(ahead?.map((l) => [l.clip, l.start])).toEqual([[id(2, 2), 2 * MICROS]]);
  expect(plan(project, sequence, SECOND, SECOND)?.segments).toEqual([]);
  expect(() => plan(project, sequence, SECOND, 0)).toThrow(RangeError);
  expect(plan(project, video, 0, SECOND)).toBe(undefined);
});

// A transition on the end of `cut`.
const dissolve = (cut: string, duration: number): Op => ({
  op: "item.add",
  item: { kind: "transition", cut, duration, effect: "dissolve", params: { softness: 1 } },
});

test("a transition plays both clips over its cut", () => {
  const { project, apply } = setUp();
  apply(clip({ anchor: at("a0"), in: 24_000 }), clip({ anchor: at("a1"), in: 24_000 }));
  const [first, second] = [id(2, 0), id(2, 1)];
  apply(dissolve(first, SECOND / 2));
  const found = plan(project, sequence, 0, 2 * SECOND);
  const shown = found?.segments.map((each) => [
    each.from,
    each.video.map((l) => [l.clip, l.start]),
    each.transitions.map((t) => [t.id, t.from, t.to, t.out, t.in]),
  ]);
  expect(shown).toEqual([
    [0, [[first, 0]], []],
    [
      0.75 * MICROS,
      [
        [first, 0],
        [second, MICROS],
      ],
      [[id(3, 0), 0.75 * MICROS, 1.25 * MICROS, first, second]],
    ],
    [1.25 * MICROS, [[second, MICROS]], []],
  ]);
  expect(found?.segments[1]?.transitions[0]?.effect).toBe("dissolve");
  expect(found?.segments[1]?.transitions[0]?.params).toEqual({ softness: 1 });
});

test("a transition shortens to the media each side has past the cut, on the frames", () => {
  const { project, apply } = setUp();
  // The second clip starts at its stream's start, so nothing of it can play before the cut.
  apply(clip({ anchor: at("a0"), in: 24_000 }), clip({ anchor: at("a1"), in: 0 }));
  apply(dissolve(id(2, 0), SECOND / 2 + 1));
  const found = plan(project, sequence, 0, 2 * SECOND);
  const [crossing] = found?.segments.flatMap((each) => each.transitions) ?? [];
  expect([crossing?.from, crossing?.to]).toEqual([MICROS, 1.25 * MICROS]);
});

test("a transition reaches into a range from a clip outside it, and into nothing after a gap", () => {
  const { project, apply } = setUp();
  apply(clip({ anchor: at("a0"), in: 24_000 }), clip({ anchor: at("a1"), in: 24_000 }), {
    op: "item.add",
    item: { kind: "gap", anchor: at("a2"), duration: SECOND },
  });
  const [first, second] = [id(2, 0), id(2, 1)];
  apply(dissolve(first, SECOND / 2), dissolve(second, SECOND / 2));
  // The second clip starts after the range, and plays early in it.
  const early = plan(project, sequence, 0, (9 * SECOND) / 10)
    ?.segments.at(-1)
    ?.video.map((l) => l.clip);
  expect(early).toEqual([first, second]);
  // The first clip ends before the range, and plays on into it.
  const late = plan(project, sequence, (11 * SECOND) / 10, (12 * SECOND) / 10)?.segments[0];
  expect(late?.video.map((l) => l.clip)).toEqual([first, second]);
  // Into the gap, only the clip before the cut plays.
  const gap = plan(project, sequence, 2 * SECOND, (21 * SECOND) / 10)?.segments[0];
  expect(gap?.video.map((l) => l.clip)).toEqual([second]);
  expect(gap?.transitions.map((t) => [t.out, t.in])).toEqual([[second, undefined]]);
});

// A gap of a second in the storyline.
const gap = (position: string): Op => ({
  op: "item.add",
  item: { kind: "gap", anchor: at(position), duration: SECOND },
});

// The transitions a plan of the range plays, with their times and sides.
const crossings = (found: ReturnType<typeof plan>) => [
  ...new Map(
    found?.segments
      .flatMap((each) => each.transitions)
      .map((t) => [t.id, [t.from, t.to, t.out, t.in]]),
  ).values(),
];

test("a transition shortens to the frames of media the clip before it has past its end", () => {
  const { project, apply } = setUp();
  // Two frames of the first clip's stream are left after it.
  apply(
    clip({ anchor: at("a0"), in: 60 * 24_000 - 24_000 - 2000 }),
    clip({ anchor: at("a1"), in: 24_000 }),
  );
  apply(dissolve(id(2, 0), SECOND / 2));
  const found = plan(project, sequence, 0, 2 * SECOND);
  expect(crossings(found)).toEqual([[0.75 * MICROS, 1_083_333, id(2, 0), id(2, 1)]]);
});

test("a transition splits in whole frames, the odd one after the cut", () => {
  const { project, apply } = setUp();
  apply(
    clip({ anchor: at("a0"), in: 24_000 }),
    clip({ anchor: at("a1"), in: 24_000 }),
    clip({ anchor: at("a2"), in: 24_000 }),
  );
  apply(dissolve(id(2, 0), 13 * FRAME), dissolve(id(2, 1), FRAME));
  const found = plan(project, sequence, 0, 3 * SECOND);
  expect(crossings(found).map(([from, to]) => [from, to])).toEqual([
    [0.75 * MICROS, 1_291_667],
    [2 * MICROS, 2_041_667],
  ]);
});

test("a clip playing backwards has its media past its end below its in-point", () => {
  const { project, apply } = setUp();
  apply(
    clip({ anchor: at("a0"), in: 24_000, speed: [-1, 1] }),
    clip({ anchor: at("a1"), in: 24_000 }),
  );
  apply(dissolve(id(2, 0), SECOND / 2));
  const found = plan(project, sequence, 0, 2 * SECOND);
  expect(crossings(found)).toEqual([[0.75 * MICROS, MICROS, id(2, 0), id(2, 1)]]);
});

test("two transitions on one short clip each take at most half of it", () => {
  const { project, apply } = setUp();
  apply(
    clip({ anchor: at("a0"), in: 24_000 }),
    clip({ anchor: at("a1"), in: 24_000, duration: 10 * FRAME }),
    clip({ anchor: at("a2"), in: 24_000 }),
  );
  apply(dissolve(id(2, 0), 16 * FRAME), dissolve(id(2, 1), 16 * FRAME));
  const found = plan(project, sequence, 0, 3 * SECOND);
  const most = Math.max(...(found?.segments.map((each) => each.video.length) ?? []));
  expect(most).toBe(2);
  expect(crossings(found)).toHaveLength(2);
});

test("a plan doesn't depend on its range, past items of no length", () => {
  const { project, apply } = setUp();
  apply(
    clip({ anchor: at("a0"), in: 24_000 }),
    clip({ anchor: at("a1"), duration: 0 }),
    clip({ anchor: at("a2"), in: 24_000 }),
  );
  apply(dissolve(id(2, 0), SECOND / 2));
  const short = crossings(plan(project, sequence, 0, (9 * SECOND) / 10));
  expect(short).toEqual([[0.75 * MICROS, 1.25 * MICROS, id(2, 0), id(2, 2)]]);
  expect(crossings(plan(project, sequence, 0, 2 * SECOND))).toEqual(short);
  // Starting past the cut, the clip before it is found past the item of no length.
  expect(crossings(plan(project, sequence, (11 * SECOND) / 10, 2 * SECOND))).toEqual(short);
  // The clip after the cut starts where a shorter range ends, so it comes next.
  const ahead = plan(project, sequence, 0, 0.75 * SECOND)?.next.map((layer) => layer.clip);
  expect(ahead).toEqual([id(2, 2)]);
});

test("a transition between gaps plays nothing, and at the storyline's end only before the cut", () => {
  const { project, apply } = setUp();
  apply(gap("a0"), gap("a1"), clip({ anchor: at("a2"), in: 24_000 }));
  apply(dissolve(id(2, 0), SECOND / 2), dissolve(id(2, 2), SECOND / 2));
  const found = plan(project, sequence, 0, 3 * SECOND);
  expect(crossings(found)).toEqual([[2.75 * MICROS, 3 * MICROS, id(2, 2), undefined]]);
});

test("of two transitions on one cut, the first by id plays", () => {
  const { project, apply } = setUp();
  apply(clip({ anchor: at("a0"), in: 24_000 }), clip({ anchor: at("a1"), in: 24_000 }));
  apply(dissolve(id(2, 0), SECOND / 2), dissolve(id(2, 0), SECOND / 4));
  const found = plan(project, sequence, 0, 2 * SECOND);
  expect(found?.segments.flatMap((each) => each.transitions.map((t) => t.id))).toEqual([id(3, 0)]);
});

test("an audio clip's fades keep to its own start and end over a transition", () => {
  const { project, apply } = setUp();
  const sound = { source: { asset, stream: 1 }, role: audio, in: 48_000 };
  apply(
    clip({
      ...sound,
      anchor: at("a0"),
      audio: { gainDb: 0, pan: 0, fadeIn: 0, fadeOut: SECOND / 4 },
    }),
    clip({ ...sound, anchor: at("a1") }),
  );
  apply(dissolve(id(2, 0), SECOND / 2));
  const [first] = plan(project, sequence, 0, 2 * SECOND)?.segments[1]?.audio ?? [];
  expect([first?.end, first?.fadeOut]).toEqual([MICROS, 0.75 * MICROS]);
});

test("a transition from a generator into a compound clip has the generator's media without end", () => {
  const { project, apply } = setUp();
  const inner = apply(
    ...innerSequence(2),
    clip({
      source: { generator: "solid", params: {} },
      role: id(2, 1),
      anchor: { storyline: id(2, 0), position: "a0" },
      duration: 2 * SECOND,
    }),
  );
  expect(inner.skipped).toEqual([]);
  // Half a second into the inner sequence, so half a second of it plays before its start.
  apply(
    clip({ source: { generator: "solid", params: {} }, anchor: at("a0") }),
    clip({ source: { sequence: id(2, 0) }, anchor: at("a1"), in: SECOND / 2 }),
  );
  apply(dissolve(id(3, 0), SECOND / 2));
  expect(crossings(plan(project, sequence, 0, 2 * SECOND))).toEqual([
    [0.75 * MICROS, 1.25 * MICROS, id(3, 0), id(3, 1)],
  ]);
});

test("a clip playing backwards after a cut has its media before its start above its in-point", () => {
  const { project, apply } = setUp();
  // The second clip plays its stream down from one second in; all of the stream above that is
  // before its start.
  apply(
    clip({ anchor: at("a0"), in: 24_000 }),
    clip({ anchor: at("a1"), in: 24_000, speed: [-1, 1] }),
  );
  apply(dissolve(id(2, 0), SECOND / 2));
  expect(crossings(plan(project, sequence, 0, 2 * SECOND))).toEqual([
    [0.75 * MICROS, 1.25 * MICROS, id(2, 0), id(2, 1)],
  ]);
});

test("a transition with no media either side of its cut plays nothing", () => {
  const { project, apply } = setUp();
  // The first clip ends at its stream's end, and the second starts at its stream's start.
  apply(clip({ anchor: at("a0"), in: 59 * 24_000 }), clip({ anchor: at("a1"), in: 0 }));
  apply(dissolve(id(2, 0), SECOND / 2));
  expect(crossings(plan(project, sequence, 0, 2 * SECOND))).toEqual([]);
});

test("a transition from a gap plays only the clip after the cut", () => {
  const { project, apply } = setUp();
  apply(gap("a0"), clip({ anchor: at("a1"), in: 24_000 }));
  apply(dissolve(id(2, 0), SECOND / 2));
  expect(crossings(plan(project, sequence, 0, 2 * SECOND))).toEqual([
    [0.75 * MICROS, 1.25 * MICROS, undefined, id(2, 1)],
  ]);
});

test("a clip's blend mode is in its layer, and an empty range has one segment with nothing", () => {
  const { project, apply } = setUp();
  expect(plan(project, sequence, 0, SECOND)?.segments).toEqual([
    { from: 0, to: MICROS, video: [], audio: [], transitions: [] },
  ]);
  const transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
  apply(clip({ video: { opacity: 1, blend: "multiply", transform } }));
  const [layer] = plan(project, sequence, 0, SECOND)?.segments[0]?.video ?? [];
  expect(layer?.blend).toBe("multiply");
});

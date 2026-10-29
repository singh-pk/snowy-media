// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The clips of a plan, in Chromium: where each reads its file and where it plays on the
// composition, from a plan in the shape @snowy-media/timeline's render plan has, and a
// NotSupportedError for each thing a plan may ask that the engine does not play.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import {
  clipsOf,
  type Plan,
  type PlanAudioLayer,
  type PlanSegment,
  type PlanVideoLayer,
} from "../src/composition";

// A clip of file "a" placed from 1 s to 2.5 s of 3 s, read from 0.5 s: its video, clip c1, in a
// 1/15360 time base, and its sound, clip a1, in 1/48000, as a timeline gives them.
function video(changes: Partial<PlanVideoLayer> = {}): PlanVideoLayer {
  return {
    clip: "c1",
    source: { asset: "a", stream: 0 },
    in: 7680,
    timeBase: [1, 15_360],
    start: 1_000_000,
    end: 2_500_000,
    speed: [1, 1],
    effects: [],
    opacity: 1,
    blend: "normal",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    ...changes,
  };
}

function audio(changes: Partial<PlanAudioLayer> = {}): PlanAudioLayer {
  return {
    clip: "a1",
    source: { asset: "a", stream: 1 },
    in: 24_000,
    timeBase: [1, 48_000],
    start: 1_000_000,
    end: 2_500_000,
    speed: [1, 1],
    effects: [],
    gainDb: 0,
    pan: 0,
    fadeIn: 1_000_000,
    fadeOut: 2_500_000,
    ...changes,
  };
}

function segment(changes: Partial<PlanSegment> = {}): PlanSegment {
  return { from: 0, to: 3_000_000, video: [], audio: [], transitions: [], ...changes };
}

const plan = (...segments: PlanSegment[]): Plan => ({ segments });
const DURATION = 3_000_000;
// A clip of another file, after the one at 1 s that ends at 2 s.
const LATER = { source: { asset: "b", stream: 0 }, start: 2_000_000, end: 3_000_000 };

// What `run` throws, or undefined.
function thrown(run: () => unknown) {
  try {
    run();
    return undefined;
  } catch (e) {
    return e;
  }
}

test("a clip's video and audio in step play from its in point at its place", () => {
  const got = clipsOf(plan(segment({ video: [video()], audio: [audio()] })), DURATION);
  const want = { clip: "c1", asset: "a", video: 0, audio: 1 };
  expect(got).toEqual([{ ...want, in: 500_000, out: 2_000_000, offset: 500_000 }]);
});

test("clips one after another play in the order they are placed, each alone or in step", () => {
  // At 0 s, the file's 2 s to 2.5 s with its sound; at 2.5 s, its sound from 0 s alone.
  const first = { start: 0, end: 500_000 };
  const v1 = video({ clip: "c2", in: 30_720, ...first });
  const a1 = audio({ clip: "a2", in: 96_000, ...first, fadeIn: 0, fadeOut: 500_000 });
  const last = { start: 2_500_000, end: 3_000_000, fadeIn: 2_500_000, fadeOut: 3_000_000 };
  const a2 = audio({ clip: "a3", in: 0, ...last });
  const got = clipsOf(
    plan(
      segment({ to: 1_000_000, video: [v1], audio: [a1] }),
      segment({ from: 1_000_000, video: [video()], audio: [a2, audio()] }),
    ),
    DURATION,
  );
  const ids = got.map((c) => [c.clip, c.video, c.audio]);
  expect(ids).toEqual([
    ["c2", 0, 1],
    ["c1", 0, 1],
    ["a3", undefined, 1],
  ]);
  expect(got.map((c) => [c.in, c.offset])).toEqual([
    [2_000_000, -2_000_000],
    [500_000, 500_000],
    [0, 2_500_000],
  ]);
});

test("video and audio cut at the same time are in step to within a tick of either time base", () => {
  // 513/15360 s is 33398 µs, and 1603/48000 s is 33396 µs: both the cut nearest 1/30 s.
  const cut = plan(segment({ video: [video({ in: 513 })], audio: [audio({ in: 1603 })] }));
  expect(clipsOf(cut, DURATION).map((c) => [c.in, c.audio])).toEqual([[33_398, 1]]);
});

test("only what plays within the composition is read", () => {
  const early = video({ start: -500_000, end: 1_000_000 });
  const late = video({ start: 2_000_000, end: 4_000_000 });
  // Read from 0.5 s, the clip at -0.5 s is read from 1 s at 0 s; the one at 2 s, to 1.5 s at 3 s.
  const [read] = clipsOf(plan(segment({ video: [early] })), DURATION);
  expect([read?.in, read?.out, read?.offset]).toEqual([1_000_000, 2_000_000, -1_000_000]);
  expect(clipsOf(plan(segment({ video: [late] })), DURATION)[0]?.out).toBe(1_500_000);
  const after = video({ start: 3_000_000, end: 4_000_000 });
  expect(clipsOf(plan(segment({ video: [after] })), DURATION)).toEqual([]);
});

test("a layer that plays on into the next segment is one layer", () => {
  const layer = video();
  const two = plan(
    segment({ to: 1_500_000, video: [layer] }),
    segment({ from: 1_500_000, video: [layer] }),
  );
  expect(clipsOf(two, DURATION).map((c) => [c.video, c.audio])).toEqual([[0, undefined]]);
});

test("a plan with no layers plays nothing", () => {
  expect(clipsOf(plan(segment()), DURATION)).toEqual([]);
  expect(clipsOf(plan(), DURATION)).toEqual([]);
});

test("what the engine does not play is a NotSupportedError that says what", () => {
  const cases: [string, Plan][] = [
    ["more than one video layer", plan(segment({ video: [video(), video({ clip: "c2" })] }))],
    ["more than one audio layer", plan(segment({ audio: [audio(), audio({ clip: "c2" })] }))],
    [
      "more than one video layer at a time",
      plan(segment({ video: [video(), video({ clip: "c2", start: 2_000_000, end: 3_000_000 })] })),
    ],
    [
      "clips of more than one file",
      plan(segment({ video: [video({ end: 2_000_000 }), video({ ...LATER, clip: "c2" })] })),
    ],
    ["a transition", plan(segment({ transitions: [{}] }))],
    ["an effect", plan(segment({ video: [video({ effects: [{}] })] }))],
    ["a speed of 2/1", plan(segment({ video: [video({ speed: [2, 1] })] }))],
    ["an opacity", plan(segment({ video: [video({ opacity: { keyframes: [] } })] }))],
    ["the blend multiply", plan(segment({ video: [video({ blend: "multiply" })] }))],
    [
      "a transform",
      plan(segment({ video: [video({ transform: { ...video().transform, scaleX: 2 } })] })),
    ],
    ["a gain", plan(segment({ audio: [audio({ gainDb: -6 })] }))],
    ["a fade", plan(segment({ audio: [audio({ fadeIn: 1_200_000 })] }))],
    [
      "a source other than a file",
      plan(segment({ video: [video({ source: { sequence: "s" } })] })),
    ],
    [
      "a source other than a file",
      plan(segment({ audio: [audio({ source: { generator: "tone", params: {} } })] })),
    ],
    ["a layer from 1000000 to 1000000", plan(segment({ video: [video({ end: 1_000_000 })] }))],
    ["not in step", plan(segment({ video: [video()], audio: [audio({ in: 24_048 })] }))],
    [
      "not in step",
      plan(segment({ video: [video()], audio: [audio({ end: 2_400_000, fadeOut: 2_400_000 })] })),
    ],
    [
      "not in step",
      plan(segment({ video: [video()], audio: [audio({ source: { asset: "b", stream: 1 } })] })),
    ],
  ];

  for (const [what, each] of cases) {
    const error = thrown(() => clipsOf(each, DURATION));
    const name = error instanceof DOMException ? error.name : String(error);
    // The name, then the message saying what, each with what was asked for.
    expect(`${what}: ${name}`).toBe(`${what}: NotSupportedError`);
    expect(`${what}: ${String(error).includes(what)}`).toBe(`${what}: true`);
  }
});

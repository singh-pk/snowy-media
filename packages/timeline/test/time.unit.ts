// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Time in flicks (src/time.ts), in Chromium: every common frame and sample is whole flicks,
// conversions round once with halves upwards, speed divides the source, video snaps down to a
// frame, and nothing past what a number holds exactly comes back.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import {
  FLICKS_PER_SECOND,
  flicksToSource,
  frameFlicks,
  snapToFrame,
  sourceToFlicks,
  sourceToFlicksDown,
  toFlicks,
} from "../src/time";

test("a frame at every common video rate is whole flicks", () => {
  const rates: Array<[[number, number], number]> = [
    [[24_000, 1001], 29_429_400],
    [[24, 1], 29_400_000],
    [[25, 1], 28_224_000],
    [[30_000, 1001], 23_543_520],
    [[30, 1], 23_520_000],
    [[48, 1], 14_700_000],
    [[50, 1], 14_112_000],
    [[60_000, 1001], 11_771_760],
    [[60, 1], 11_760_000],
    [[120_000, 1001], 5_885_880],
    [[120, 1], 5_880_000],
  ];
  for (const [rate, flicks] of rates) expect(frameFlicks(rate)).toBe(flicks);
});

test("a sample at every common audio rate is whole flicks", () => {
  expect([44_100, 48_000, 88_200, 96_000].map((rate) => frameFlicks([rate, 1]))).toEqual([
    16_000, 14_700, 8000, 7350,
  ]);
});

test("a rate whose frame isn't whole flicks, or that isn't a positive fraction, is refused", () => {
  expect(() => frameFlicks([13, 1])).toThrow(RangeError);
  expect(() => frameFlicks([1_000_000, 1])).toThrow(RangeError);
  expect(() => frameFlicks([0, 1])).toThrow(RangeError);
  expect(() => frameFlicks([24, 0])).toThrow(RangeError);
  expect(() => frameFlicks([-24, 1])).toThrow(RangeError);
  expect(() => frameFlicks([23.976, 1])).toThrow(RangeError);
});

test("a second in any time base is FLICKS_PER_SECOND", () => {
  expect(toFlicks(90_000, [1, 90_000])).toBe(FLICKS_PER_SECOND);
  expect(toFlicks(15_360, [1, 15_360])).toBe(FLICKS_PER_SECOND);
  expect(toFlicks(1001, [1, 1001])).toBe(FLICKS_PER_SECOND);
});

test("a conversion rounds once to the nearest flick, halves upwards, also below zero", () => {
  // 1/15360 s is 45,937.5 flicks.
  expect(toFlicks(1, [1, 15_360])).toBe(45_938);
  expect(toFlicks(-1, [1, 15_360])).toBe(-45_937);
  expect(toFlicks(3, [1, 15_360])).toBe(137_813);
  expect(toFlicks(-3, [1, 15_360])).toBe(-137_812);
});

test("a sum of exact steps doesn't drift, however many there are", () => {
  // 24000 frames at 24000/1001 fps are exactly 1001 seconds.
  const frame = frameFlicks([24_000, 1001]);
  expect(frame * 24_000).toBe(toFlicks(1001, [1, 1]));
});

test("flicks past what a number holds exactly are refused, not rounded", () => {
  // 2^53 flicks is about 147.7 days.
  expect(toFlicks(12_000_000, [1, 1])).toBe(12_000_000 * FLICKS_PER_SECOND);
  expect(() => toFlicks(13_000_000, [1, 1])).toThrow(RangeError);
  expect(() => toFlicks(2 ** 53, [1, 1])).toThrow(RangeError);
  expect(() => toFlicks(0.5, [1, 1])).toThrow(RangeError);
  expect(() => frameFlicks([1, 2 ** 52])).toThrow(RangeError);
  expect(() => snapToFrame(Number.MIN_SAFE_INTEGER, [24, 1])).toThrow(RangeError);
});

test("speed divides the source: double speed takes half the time, reverse goes back", () => {
  expect(sourceToFlicks(48, [1, 48], [1, 1])).toBe(FLICKS_PER_SECOND);
  expect(sourceToFlicks(48, [1, 48], [2, 1])).toBe(FLICKS_PER_SECOND / 2);
  expect(sourceToFlicks(48, [1, 48], [1, 2])).toBe(FLICKS_PER_SECOND * 2);
  expect(sourceToFlicks(48, [1, 48], [-1, 1])).toBe(-FLICKS_PER_SECOND);
  expect(sourceToFlicks(-48, [1, 48], [-1, 1])).toBe(FLICKS_PER_SECOND);
});

test("a source offset rounds once, after dividing by speed", () => {
  // 1/15360 s at half speed is 91,875 flicks exactly, not twice a rounded 45,938.
  expect(sourceToFlicks(1, [1, 15_360], [1, 2])).toBe(91_875);
  expect(sourceToFlicks(1, [1, 15_360], [-1, 1])).toBe(-45_937);
  expect(() => sourceToFlicks(1, [1, 15_360], [0, 1])).toThrow(RangeError);
});

test("flicks played at a speed are that much source, rounded once", () => {
  expect(flicksToSource(FLICKS_PER_SECOND, [1, 48], [1, 1])).toBe(48);
  expect(flicksToSource(FLICKS_PER_SECOND, [1, 48], [2, 1])).toBe(96);
  expect(flicksToSource(FLICKS_PER_SECOND, [1, 48], [-1, 2])).toBe(-24);
  // A unit of 1/15360 s is 45,937.5 flicks: 22,968 is just under half of one, 22,969 just over.
  expect(flicksToSource(22_968, [1, 15_360], [1, 1])).toBe(0);
  expect(flicksToSource(22_969, [1, 15_360], [1, 1])).toBe(1);
  expect(() => flicksToSource(Number.MAX_SAFE_INTEGER, [1, 2 ** 40], [1, 1])).toThrow(RangeError);
});

test("a time base that isn't a positive fraction is refused", () => {
  expect(() => toFlicks(1, [0, 1])).toThrow(RangeError);
  expect(() => toFlicks(1, [-1, 1])).toThrow(RangeError);
  expect(() => toFlicks(1, [1, 0])).toThrow(RangeError);
  expect(() => sourceToFlicks(1, [-1, 15_360], [1, 1])).toThrow(RangeError);
});

test("video snaps down to the frame boundary at or before it", () => {
  const frame = frameFlicks([24, 1]);
  expect(snapToFrame(0, [24, 1])).toBe(0);
  expect(snapToFrame(frame - 1, [24, 1])).toBe(0);
  expect(snapToFrame(frame, [24, 1])).toBe(frame);
  expect(snapToFrame(frame * 2 + 1, [24, 1])).toBe(frame * 2);
  expect(snapToFrame(-1, [24, 1])).toBe(-frame);
});

test("how long a stream plays, rounded down, is the same played backwards, and nothing at no speed", () => {
  // A second at 11 times speed is 705,600,000 / 11 flicks, which isn't whole.
  const down = Math.floor(FLICKS_PER_SECOND / 11);
  expect(sourceToFlicksDown(1, [1, 1], [11, 1])).toBe(down);
  expect(sourceToFlicksDown(1, [1, 1], [-11, 1])).toBe(down);
  expect(() => sourceToFlicksDown(1, [1, 1], [0, 1])).toThrow("speed is zero");
});

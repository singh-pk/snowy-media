// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Where connected items go (docs/architecture.md#layout): the time an anchor gives, and the lane
// each item of a role takes. Both are worked out from anchors and durations, the same way on
// every peer, and never stored.

import type { ItemId } from "./ids";
import { frameFlicks, snapToFrame, sourceToFlicks, type Ratio } from "./time";

/** What layout needs of the storyline clip a connected item is anchored to. */
export type AnchorClip = {
  /** Where the clip starts on the timeline, in flicks. */
  start: number;
  /** Its in-point, in `timeBase` units. */
  in: number;
  speed: Ratio;
  /** Its stream's time base; `[1, FLICKS_PER_SECOND]` for a generator or a sequence. */
  timeBase: Ratio;
};

function flicks(value: number) {
  if (!Number.isSafeInteger(value)) throw new RangeError(`not a time in flicks: ${value}`);
  return value;
}

/**
 * Where an item connected to `clip` at source point `at` starts, in flicks: `start + (at − in) /
 * speed`, where `in` is the point at the clip's start even at a negative speed. `at` may lie
 * outside the clip. A video item passes its sequence's `rate` and is snapped down to a frame.
 */
export function clipAnchorStart(clip: AnchorClip, at: number, rate?: Ratio) {
  const start = flicks(clip.start + sourceToFlicks(at - clip.in, clip.timeBase, clip.speed));
  return rate === undefined ? start : snapToFrame(start, rate);
}

/**
 * Where an item connected to a sequence's start at `at` flicks starts. A video item passes its
 * sequence's `rate` and is snapped down to a frame.
 */
export function originAnchorStart(at: number, rate?: Ratio) {
  return rate === undefined ? flicks(at) : snapToFrame(at, rate);
}

/**
 * The halves of a transition of `duration` flicks on either side of its cut, in whole frames of
 * `rate`: the frames before the cut, rounded down, and the rest after it. Storyline items are
 * whole frames, so both halves start and end on frames.
 */
export function transitionHalves(duration: number, rate: Ratio) {
  const frame = frameFlicks(rate);
  // Exact for safe integers, as a float division near the limit might not be.
  const frames = (duration - (duration % frame)) / frame;
  const before = Math.floor(frames / 2) * frame;
  return { before, after: frames * frame - before };
}

/** A connected item of one role, placed in time, with the lane it prefers. */
export type Connected = { id: ItemId; start: number; duration: number; lane: number };

function byStartThenId(a: Connected, b: Connected) {
  if (a.start !== b.start) return a.start - b.start;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * The lane of each item, by id. Taken by start, then id, each item gets the lane it prefers if
 * that lane is free over its whole range, or else the nearest free lane above. The items before it
 * all start at or before it, so a lane is free once everything in it has ended by its start.
 * Throws a RangeError for a lane or duration that isn't a non-negative safe integer, or a start
 * or end that isn't a time in flicks.
 */
export function assignLanes(items: Connected[]) {
  const ends = new Map<number, number>();
  const lanes = new Map<ItemId, number>();

  for (const item of items.toSorted(byStartThenId)) {
    if (!Number.isSafeInteger(item.lane) || item.lane < 0) {
      throw new RangeError(`not a lane: ${item.lane}`);
    }

    if (!Number.isSafeInteger(item.duration) || item.duration < 0) {
      throw new RangeError(`not a duration: ${item.duration}`);
    }

    flicks(item.start);
    flicks(item.start + item.duration);
    let lane = item.lane;
    while ((ends.get(lane) ?? Number.NEGATIVE_INFINITY) > item.start) lane += 1;
    ends.set(
      lane,
      Math.max(ends.get(lane) ?? Number.NEGATIVE_INFINITY, item.start + item.duration),
    );
    lanes.set(item.id, lane);
  }

  return lanes;
}

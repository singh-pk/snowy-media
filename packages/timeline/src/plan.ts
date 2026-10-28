// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The render plan (docs/architecture.md#queries-and-the-render-plan): a range of a sequence, cut
// into segments in which the set of layers doesn't change. Times are microseconds from here on,
// converted from flicks once each; source points stay in their stream's units.

import type { ItemRecord, KeyframeRecord, SequenceRecord, Value } from "./document";
import type { ItemId } from "./ids";
import type { Document } from "./project";
import { leafOf } from "./project";
import { transitionHalves } from "./layout";
import {
  flicksToMicros,
  flicksToSource,
  frameFlicks,
  sourceToFlicks,
  sourceToFlicksDown,
  type Ratio,
} from "./time";

type Clip = Extract<ItemRecord, { kind: "clip" }>;
type Blend = NonNullable<Clip["video"]>["blend"];

/** A keyframe at its time on the timeline, in microseconds. */
type PlannedKeyframe = { at: number; value: Value; ease: KeyframeRecord["ease"] };

/** A parameter: its value, or its keyframes in time order when it is animated. */
type Animated = Value | { keyframes: PlannedKeyframe[] };

type PlannedEffect = { id: ItemId; kind: string; params: Record<string, Animated> };

/**
 * How a layer reads its source: the clip's in-point in its stream's `timeBase` (flicks for a
 * generator or a sequence), played from `start` on the timeline, in microseconds, at `speed`.
 * A source time is `in + (t − start) × speed`, in seconds converted to `timeBase`.
 */
type Layer = {
  clip: ItemId;
  source:
    | { asset: string; stream: number }
    | { generator: string; params: Record<string, Animated> }
    | { sequence: ItemId };
  in: number;
  timeBase: Ratio;
  start: number;
  /** Where the clip ends on the timeline, in microseconds; a transition can play it past that. */
  end: number;
  speed: Ratio;
  effects: PlannedEffect[];
};

type VideoLayer = Layer & {
  opacity: Animated;
  blend: Blend;
  transform: { x: Animated; y: Animated; scaleX: Animated; scaleY: Animated; rotation: Animated };
};

/** Mixed into its role's bus, `bus`. */
type AudioLayer = Layer & {
  gainDb: Animated;
  pan: Animated;
  /** Where the fade in ends and the fade out starts, in microseconds. */
  fadeIn: number;
  fadeOut: number;
  bus: ItemId;
};

/** A transition playing over a cut: from the clip before it, `out`, to the one after, `in`. */
type PlannedTransition = {
  id: ItemId;
  effect: string;
  params: Record<string, Value>;
  from: number;
  to: number;
  out?: ItemId;
  in?: ItemId;
};

/**
 * A part of the range in which the same layers play: video bottom to top, and audio, and the
 * transitions playing. A layer that plays on into the next segment is the same object there.
 */
type Segment = {
  from: number;
  to: number;
  video: VideoLayer[];
  audio: AudioLayer[];
  transitions: PlannedTransition[];
};

/** The plan of a range: the sequence, its segments, and the layers that start where it ends. */
type Plan = {
  sequence: SequenceRecord & { id: ItemId };
  segments: Segment[];
  next: Array<VideoLayer | AudioLayer>;
};

// A clip as placed: where it starts and ends, where it plays, which a transition can widen, and
// what orders it among the others: the storyline first, then each role in order, then each lane
// from the lowest up.
type Placed = {
  clip: Clip & { id: ItemId };
  start: number;
  end: number;
  from: number;
  to: number;
  order: number[];
  video: boolean;
};

// A transition as placed, its times in flicks.
type Crossing = PlannedTransition;

type Scope = { document: Document; sequence: ItemId; record: SequenceRecord };

// What animates a placed clip's parameters: the keyframes on the clip or one of its effects.
type Animating = { document: Document; each: Placed; keyframes: readonly KeyframeRecord[] };

const byOrder = (a: Placed, b: Placed) => {
  for (const [i, value] of a.order.entries()) {
    const other = b.order[i] ?? 0;
    if (value !== other) return value - other;
  }

  return 0;
};

/**
 * The render plan of `sequence` from `from` to `to`, in flicks, or undefined for a sequence the
 * document doesn't have. Disabled clips, clips of no length, gaps and markers play nothing.
 * Throws a RangeError for a range that ends before it starts.
 */
export function plan(document: Document, sequence: ItemId, from: number, to: number) {
  if (to < from) throw new RangeError(`a range from ${from} to ${to}`);
  const record = document.sequence(sequence);
  if (record === undefined) return undefined;
  const { placed, crossings } = placedClips({ document, sequence, record }, from, to);
  // In compositing order, so a segment's layers keep that order as they come and go.
  const layers = new Map(placed.map((each) => [each, layerOf(document, each)]));
  const cuts = new Set([from, to]);
  const within = (time: number) => time > from && time < to;

  for (const each of [...placed, ...crossings]) {
    if (within(each.from)) cuts.add(each.from);
    if (within(each.to)) cuts.add(each.to);
  }

  const bounds = [...cuts].toSorted((a, b) => a - b);
  const segments: Segment[] = [];

  for (const [i, start] of bounds.slice(0, -1).entries()) {
    const end = bounds[i + 1] ?? to;
    const segment: Segment = {
      from: flicksToMicros(start),
      to: flicksToMicros(end),
      video: [],
      audio: [],
      transitions: [],
    };

    for (const [each, layer] of layers) {
      if (each.from > start || each.to < end) continue;
      if ("opacity" in layer) segment.video.push(layer);
      else segment.audio.push(layer);
    }

    for (const each of crossings) {
      if (each.from > start || each.to < end) continue;
      segment.transitions.push({
        ...each,
        from: flicksToMicros(each.from),
        to: flicksToMicros(each.to),
      });
    }

    segments.push(segment);
  }

  const next = placed.filter((each) => each.from === to).flatMap((each) => layers.get(each) ?? []);
  return { sequence: { id: sequence, ...record }, segments, next } satisfies Plan;
}

// How long a clip's source plays on past its end, or before its start, in flicks on the timeline,
// rounded down: as far as its stream goes, as far as the sequence it plays goes, or without end
// for a generator.
function media(document: Document, clip: Clip, side: "after" | "before") {
  const { source } = clip;
  if ("generator" in source) return Number.POSITIVE_INFINITY;
  const timeBase = document.timeBase(clip);
  let first = 0;
  let last: number;

  if ("asset" in source) {
    const found = document.asset(source.asset)?.streams.find((s) => s.index === source.stream);
    if (found === undefined) return 0;
    first = found.start;
    last = found.start + found.duration;
  } else last = document.length(source.sequence);

  const forwards = clip.speed[0] > 0;
  const end = clip.in + flicksToSource(clip.duration, timeBase, clip.speed);
  // At a negative speed the source runs down, so what is past the end is below it.
  const left =
    side === "after"
      ? forwards
        ? last - end
        : end - first
      : forwards
        ? clip.in - first
        : last - clip.in;
  return left <= 0 ? 0 : sourceToFlicksDown(left, timeBase, clip.speed);
}

// Every enabled clip of a sequence that plays between `from` and `to`, or starts at `to`, with
// its place, in compositing order, and the transitions playing there.
function placedClips(scope: Scope, from: number, to: number) {
  const { document, sequence } = scope;
  const roles = document.roles(sequence);
  const kinds = new Map(roles.map((role) => [role.id, role.kind]));
  const candidates: Placed[] = [];

  const take = (id: ItemId, start: number, order: number[]) => {
    const clip = document.item(id);
    if (clip?.kind !== "clip" || !clip.enabled || clip.duration === 0) return undefined;
    const end = start + clip.duration;
    const video = kinds.get(clip.role) === "video";
    const each = { clip, start, end, from: start, to: end, order, video };
    candidates.push(each);
    return each;
  };

  // Items of no length are passed over, as they are in looking up the item at a time, so the
  // plan doesn't depend on where the range starts.
  const line = document.storyline(sequence, { from, to }).filter((item) => item.duration > 0);
  let prior = line[0] === undefined ? undefined : document.itemBefore(line[0].id);
  while (prior?.duration === 0) prior = document.itemBefore(prior.id);
  const items = prior === undefined ? line : [prior, ...line];
  const stories = items.map((item) => ({ item, placed: take(item.id, item.start, [0]) }));
  const crossings = crossingsOf(scope, stories, take);

  for (const [index, role] of roles.entries()) {
    for (const { id, start, lane } of document.connected(role.id)) {
      take(id, start, [1, index, lane]);
    }
  }

  const placed = candidates.filter((each) => each.to > from && each.from <= to).toSorted(byOrder);
  return { placed, crossings: crossings.filter((each) => each.to > from && each.from < to) };
}

type Story = { item: { id: ItemId; start: number; duration: number }; placed: Placed | undefined };

// The transitions on the cuts after `stories`, widening the clips each side to play through them.
// Each half shortens on its own, to the media its side has past the cut and to half the item next
// to the cut, so two transitions on one item never meet. Of two on one cut, the first by id plays.
function crossingsOf(
  { document, sequence, record }: Scope,
  stories: Story[],
  take: (id: ItemId, start: number, order: number[]) => Placed | undefined,
) {
  const crossings: Crossing[] = [];
  const frame = frameFlicks(record.rate);

  // Half an item, in whole frames, as storyline items are: the first half takes the odd frame.
  const half = (duration: number, part: "first" | "last") => {
    const frames = (duration - (duration % frame)) / frame;
    const first = Math.floor(frames / 2);
    return (part === "first" ? frames - first : first) * frame;
  };

  for (const [i, { item, placed: out }] of stories.entries()) {
    const [transition] = document.transitions(item.id);
    if (transition === undefined) continue;
    const cut = item.start + item.duration;
    let after = stories[i + 1];

    // The item after the last one in the range, which the transition can reach back into it.
    if (after === undefined) {
      const [found] = document.storyline(sequence, { from: cut, to: cut });
      after = found && { item: found, placed: take(found.id, found.start, [0]) };
    }

    const { placed: into } = after ?? {};
    if (out === undefined && into === undefined) continue;
    const { before, after: rest } = transitionHalves(transition.duration, record.rate);
    // Before the cut the clip after it plays early, from its media before its start; after the
    // cut the clip before it plays on, from its media past its end.
    let left = Math.min(before, half(item.duration, "last"));
    let right = Math.min(rest, half(after?.item.duration ?? 0, "first"));
    if (into !== undefined) left = Math.min(left, media(document, into.clip, "before"));
    if (out !== undefined) right = Math.min(right, media(document, out.clip, "after"));
    left -= left % frame;
    right -= right % frame;
    if (left + right === 0) continue;
    if (out !== undefined) out.to = cut + right;
    if (into !== undefined) into.from = cut - left;
    crossings.push({
      id: transition.id,
      effect: transition.effect,
      params: transition.params,
      from: cut - left,
      to: cut + right,
      ...(out === undefined ? {} : { out: out.clip.id }),
      ...(into === undefined ? {} : { in: into.clip.id }),
    });
  }

  return crossings;
}

// A parameter at `param`: its keyframes among `keyframes`, on the timeline in time order, if it
// has any, else `value`. At a negative speed, source order is the reverse of time order.
function animated(
  { document, each: { clip, start }, keyframes }: Animating,
  param: string,
  value: Value,
): Animated {
  const own = keyframes.filter((each) => each.param === param);
  if (own.length === 0) return value;
  const timeBase = document.timeBase(clip);
  const planned = own.map(({ at, value: then, ease }) => ({
    at: flicksToMicros(start + sourceToFlicks(at - clip.in, timeBase, clip.speed)),
    value: then,
    ease,
  }));
  return { keyframes: planned.toSorted((a, b) => a.at - b.at) };
}

function paramsOf(animating: Animating, values: Record<string, Value>, prefix = "") {
  const found: Record<string, Animated> = {};

  for (const [name, value] of Object.entries(values)) {
    found[name] = animated(animating, `${prefix}${name}`, value);
  }

  return found;
}

function layerOf(document: Document, each: Placed): VideoLayer | AudioLayer {
  const { clip } = each;
  const { source } = clip;
  const animate = (target: ItemId) => ({ document, each, keyframes: document.keyframes(target) });
  const effects = document
    .effects(clip.id)
    .filter((effect) => effect.enabled)
    .map((effect) => ({
      id: effect.id,
      kind: effect.kind,
      params: paramsOf(animate(effect.id), effect.params),
    }));
  const planned: Layer["source"] =
    "generator" in source
      ? {
          generator: source.generator,
          params: paramsOf(animate(clip.id), source.params, "source.params."),
        }
      : source;
  const layer: Layer = {
    clip: clip.id,
    source: planned,
    in: clip.in,
    timeBase: document.timeBase(clip),
    start: flicksToMicros(each.start),
    end: flicksToMicros(each.end),
    speed: clip.speed,
    effects,
  };
  const own = animate(clip.id);
  const field = (path: string) => animated(own, path, leafOf(clip, path) ?? 0);

  if (each.video) {
    return Object.assign(layer, {
      opacity: field("video.opacity"),
      blend: clip.video?.blend ?? "normal",
      transform: {
        x: field("video.transform.x"),
        y: field("video.transform.y"),
        scaleX: field("video.transform.scaleX"),
        scaleY: field("video.transform.scaleY"),
        rotation: field("video.transform.rotation"),
      },
    });
  }

  return Object.assign(layer, {
    gainDb: field("audio.gainDb"),
    pan: field("audio.pan"),
    fadeIn: flicksToMicros(each.start + (clip.audio?.fadeIn ?? 0)),
    fadeOut: flicksToMicros(each.end - (clip.audio?.fadeOut ?? 0)),
    bus: clip.role,
  });
}

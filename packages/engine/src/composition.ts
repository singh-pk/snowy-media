// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// What a composition is to the engine: the shape of the plan it reads, which the render plan of
// @snowy-media/timeline fits, and the one clip of a plan it plays, checked. Times on the
// composition are microseconds; a source point is in its stream's time base.

/** A rational number, `[numerator, denominator]`. */
export type Ratio = [number, number];

/**
 * How a layer reads its source: from `in`, in `timeBase`, played from `start` on the
 * composition at `speed`, to `end`. Its source time at `t` is `in + (t − start) × speed`.
 */
export interface PlanLayer {
  clip: string;
  source:
    | { asset: string; stream: number }
    | { generator: string; params: Record<string, unknown> }
    | { sequence: string };
  in: number;
  timeBase: Ratio;
  start: number;
  end: number;
  speed: Ratio;
  effects: unknown[];
}

export interface PlanVideoLayer extends PlanLayer {
  opacity: unknown;
  blend: string;
  transform: { x: unknown; y: unknown; scaleX: unknown; scaleY: unknown; rotation: unknown };
}

/** Faded in up to `fadeIn` and out from `fadeOut`. */
export interface PlanAudioLayer extends PlanLayer {
  gainDb: unknown;
  pan: unknown;
  fadeIn: number;
  fadeOut: number;
}

/** A part of the composition, from `from` to `to`, in which the same layers play. */
export interface PlanSegment {
  from: number;
  to: number;
  video: PlanVideoLayer[];
  audio: PlanAudioLayer[];
  transitions: unknown[];
}

/** What plays over a range of a composition. */
export interface Plan {
  segments: PlanSegment[];
}

export interface Composition {
  /** How long it is, in microseconds. */
  duration: number;
  /** What plays from `from` to `to`, in microseconds. */
  plan(from: number, to: number): Plan;
  /** The file asset `asset` is in. */
  source(asset: string): FileSystemFileHandle | Promise<FileSystemFileHandle>;
}

/**
 * The one clip of a composition: the asset and the streams of it that play, and where, in
 * microseconds: from `in` to `out` in the file, played on the composition from `in + offset`.
 */
export interface Clip {
  clip: string;
  asset: string;
  video: number | undefined;
  audio: number | undefined;
  in: number;
  out: number;
  offset: number;
}

const unsupported = (what: string) =>
  new DOMException(`compose: ${what} is not supported`, "NotSupportedError");

// Whether `value` is the parameter's value `plain` throughout, not keyframed.
const still = (value: unknown, plain: unknown) => value === plain;

// The layers of `plan`, each once: a layer that plays on into the next segment is one layer.
function layersOf(plan: Plan) {
  const video = new Map<string, PlanVideoLayer>();
  const audio = new Map<string, PlanAudioLayer>();

  for (const segment of plan.segments) {
    if (segment.transitions.length > 0) throw unsupported("a transition");
    for (const layer of segment.video) video.set(`${layer.clip}:${sourceKey(layer)}`, layer);
    for (const layer of segment.audio) audio.set(`${layer.clip}:${sourceKey(layer)}`, layer);
  }

  return { video, audio };
}

function sourceKey({ source }: PlanLayer) {
  if ("asset" in source) return `${source.asset}#${source.stream}`;
  return "generator" in source ? `generator:${source.generator}` : `sequence:${source.sequence}`;
}

function checkLayer(layer: PlanLayer) {
  if (!("asset" in layer.source)) throw unsupported("a source other than a file");
  const [num, den] = layer.speed;
  if (num !== den) throw unsupported(`a speed of ${num}/${den}`);
  if (layer.effects.length > 0) throw unsupported("an effect");
  if (!(layer.end > layer.start)) throw unsupported(`a layer from ${layer.start} to ${layer.end}`);
}

function checkVideo(layer: PlanVideoLayer) {
  checkLayer(layer);
  const { x, y, scaleX, scaleY, rotation } = layer.transform;
  if (!still(layer.opacity, 1)) throw unsupported("an opacity other than 1");
  if (layer.blend !== "normal") throw unsupported(`the blend ${layer.blend}`);
  const moved = !still(x, 0) || !still(y, 0) || !still(rotation, 0);
  if (moved || !still(scaleX, 1) || !still(scaleY, 1)) throw unsupported("a transform");
}

function checkAudio(layer: PlanAudioLayer) {
  checkLayer(layer);
  if (!still(layer.gainDb, 0) || !still(layer.pan, 0)) throw unsupported("a gain or a pan");
  if (layer.fadeIn !== layer.start || layer.fadeOut !== layer.end) throw unsupported("a fade");
}

const streamOf = (layer: PlanLayer | undefined) =>
  layer && "asset" in layer.source ? layer.source.stream : undefined;

const assetOf = ({ source }: PlanLayer) => ("asset" in source ? source.asset : undefined);

// Where `layer` reads its file from and to, and its offset on the composition, in microseconds.
function placeOf(layer: PlanLayer) {
  const [num, den] = layer.timeBase;
  const from = Math.round((layer.in * num * 1e6) / den);
  return { in: from, out: from + layer.end - layer.start, offset: layer.start - from };
}

// A tick of `layer`'s time base, in microseconds.
const tickOf = ({ timeBase: [num, den] }: PlanLayer) => (num * 1e6) / den;

// Whether `v` and `a` play one file in step: placed alike, and cut at the same time, which in
// their own time bases is the same to within a tick of the coarser one. A timeline's picture and
// its sound are two clips, so their clip ids differ.
function inStep(v: PlanVideoLayer, a: PlanAudioLayer) {
  const near = Math.abs(placeOf(v).in - placeOf(a).in) < Math.max(tickOf(v), tickOf(a));
  return assetOf(v) === assetOf(a) && v.start === a.start && v.end === a.end && near;
}

/**
 * The one clip `plan` plays within `duration` microseconds, or undefined for a plan that plays
 * nothing there. Throws a NotSupportedError for what the engine does not play: more than one
 * layer of video or audio, video and audio that are not of one file in step, a transition, an
 * effect, a speed, and any opacity, blend, transform, gain, pan or fade but the plain one.
 */
export function clipOf(plan: Plan, duration: number): Clip | undefined {
  const { video, audio } = layersOf(plan);
  if (video.size > 1) throw unsupported("more than one video layer");
  if (audio.size > 1) throw unsupported("more than one audio layer");
  const v = video.values().next().value;
  const a = audio.values().next().value;
  if (v) checkVideo(v);
  if (a) checkAudio(a);
  const first = v ?? a;
  if (!first || !("asset" in first.source)) return undefined;
  if (v && a && !inStep(v, a)) throw unsupported("video and audio that are not in step");
  // What of the clip plays within the composition, in the file.
  const { offset, ...place } = placeOf(first);
  const from = Math.max(place.in, -offset);
  const to = Math.min(place.out, duration - offset);
  if (from >= to) return undefined;
  const asset = first.source.asset;
  return {
    clip: first.clip,
    asset,
    video: streamOf(v),
    audio: streamOf(a),
    in: from,
    out: to,
    offset,
  };
}

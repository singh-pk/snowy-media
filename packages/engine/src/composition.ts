// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// What a composition is to the engine (docs/architecture.md#compositions): the shape of the plan
// it reads, which the render plan of @snowy-media/timeline fits, and the clips of a plan it
// plays, checked. Times on the composition are microseconds; a source point is in its stream's
// time base.

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

/** An audio layer, faded in from `start` up to `fadeIn` and out from `fadeOut` to `end`. */
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
  /** The handle of the file that holds `asset`. */
  source(asset: string): FileSystemFileHandle | Promise<FileSystemFileHandle>;
}

/**
 * A clip of a composition: the asset and the streams of it that play, and where, in
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

type Placed = Pick<Clip, "in" | "out" | "offset">;

/** Where a clip starts and ends on the composition, in microseconds. */
export const startOf = (c: Placed) => c.in + c.offset;
export const endOf = (c: Placed) => c.out + c.offset;

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

// The file `layer` reads, the only source played.
function fileOf({ source }: PlanLayer) {
  if (!("asset" in source)) throw unsupported("a source other than a file");
  return source;
}

function checkLayer(layer: PlanLayer) {
  fileOf(layer);
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

const streamOf = (layer: PlanLayer | undefined) => layer && fileOf(layer).stream;

const assetOf = (layer: PlanLayer) => fileOf(layer).asset;

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

type Pair =
  | { v: PlanVideoLayer; a: PlanAudioLayer | undefined }
  | { v: undefined; a: PlanAudioLayer };

// Layers that may be in step: of one asset, placed alike.
const alike = (layer: PlanLayer) => `${assetOf(layer)}:${layer.start}:${layer.end}`;

// Each video layer with the audio layer in step with it, if there is one, and every other layer
// alone. Only layers of one asset placed alike can be in step, so only those are compared.
function pairsOf(video: Iterable<PlanVideoLayer>, audio: Iterable<PlanAudioLayer>) {
  const unpaired = Map.groupBy(audio, alike);
  const pairs: Pair[] = [];

  for (const v of video) {
    const candidates = unpaired.get(alike(v)) ?? [];
    const at = candidates.findIndex((a) => inStep(v, a));
    pairs.push({ v, a: candidates[at] });
    if (at >= 0) candidates.splice(at, 1);
  }

  for (const left of unpaired.values()) for (const a of left) pairs.push({ v: undefined, a });
  return pairs;
}

// The clip of `pair`, cut to the part that plays within `duration`, or undefined if none does.
function clipOf({ v, a }: Pair, duration: number): Clip | undefined {
  const first = v ?? a;
  const { offset, ...place } = placeOf(first);
  // In the file's time.
  const from = Math.max(place.in, -offset);
  const to = Math.min(place.out, duration - offset);
  if (from >= to) return undefined;
  return {
    clip: first.clip,
    asset: assetOf(first),
    video: streamOf(v),
    audio: streamOf(a),
    in: from,
    out: to,
    offset,
  };
}

// Throws if two of `clips`, in the order they play, show video at once.
function checkVideoCuts(clips: Clip[]) {
  const shown = { until: -Infinity };

  for (const clip of clips) {
    if (clip.video === undefined) continue;
    if (startOf(clip) < shown.until) throw unsupported("more than one video layer at a time");
    shown.until = Math.max(shown.until, endOf(clip));
  }
}

const overlap = (a: Clip, b: Clip) => startOf(a) < endOf(b) && startOf(b) < endOf(a);

/**
 * The clips `plan` plays within `duration` microseconds, in the order they play: each a layer
 * of video and a layer of audio of one file in step, or either alone. Audio may play at once;
 * video may not. Throws a NotSupportedError for what the engine does not play: two video layers
 * at once, a source other than a file, a transition, an effect, a speed other than 1,
 * and any opacity, blend, transform, gain, pan or fade but the plain one.
 */
export function clipsOf(plan: Plan, duration: number): Clip[] {
  const { video, audio } = layersOf(plan);
  for (const v of video.values()) checkVideo(v);
  for (const a of audio.values()) checkAudio(a);
  const clips = pairsOf(video.values(), audio.values()).flatMap((pair) => {
    const clip = clipOf(pair, duration);
    return clip ? [clip] : [];
  });
  clips.sort((a, b) => startOf(a) - startOf(b));
  checkVideoCuts(clips);
  return clips;
}

/**
 * The clips of `clips` a play from `from` microseconds reaches, each it starts in cut to start
 * there.
 */
export function clipsFrom<T extends Placed>(clips: T[], from: number) {
  const reached: T[] = [];

  for (const clip of clips) {
    if (endOf(clip) <= from) continue;
    // copy: a clip the play starts in, once a play, so the plan's own is left as it is.
    reached.push(startOf(clip) < from ? { ...clip, in: from - clip.offset } : clip);
  }

  return reached;
}

/**
 * `clips` (from `clipsOf`) on as few tracks as play none of theirs at once, each in the order
 * they play: the first holds every clip with video, and a clip of audio alone goes on the first
 * track free for all of its time.
 */
export function tracksOf(clips: Clip[]): [Clip[], ...Clip[][]] {
  const first: Clip[] = [];
  const tracks: [Clip[], ...Clip[][]] = [first];
  for (const clip of clips) if (clip.video !== undefined) first.push(clip);

  for (const clip of clips) {
    if (clip.video !== undefined) continue;
    const free = tracks.find((track) => !track.some((other) => overlap(other, clip)));
    if (free) free.push(clip);
    else tracks.push([clip]);
  }

  for (const track of tracks) track.sort((a, b) => startOf(a) - startOf(b));
  return tracks;
}

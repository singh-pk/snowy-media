// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Splitting a clip in two and joining two pieces back (docs/architecture.md#operation-kinds): the
// pieces always meet, and what sits on a piece, its connected items, a transition on its cut and
// its keyframes, goes with the part of the source it is on.

import type { Anchor, KeyframeRecord } from "./document";
import type { ItemId } from "./ids";
import { start, startOf, timeBaseOf } from "./placement";
import { keyBetween } from "./position";
import {
  addRecord,
  inStoryline,
  live,
  liveClip,
  replace,
  storylineOf,
  type Clip,
  type Records,
} from "./records";
import { guarded, skip } from "./skip";
import { flicksToSource } from "./time";

/** A clip, with its id. */
type Piece = { id: ItemId; clip: Clip };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Whether a source point is in the second piece of a clip split at `point`: the second piece plays
// on from it, upwards, or downwards in reverse.
const pastSplit = (at: number, point: number, clip: Clip) =>
  clip.speed[0] > 0 ? at >= point : at <= point;

// A clip with one of its fades set to `length`; a clip without audio has none.
function withFade(clip: Clip, fade: "fadeIn" | "fadeOut", length: number) {
  return clip.audio === undefined ? clip : { ...clip, audio: { ...clip.audio, [fade]: length } };
}

// Where the second piece of `clip` goes, `offset` flicks into it: next in the storyline, or that
// much later on its anchor.
function pieceAnchor(records: Records, clip: Clip, offset: number, sequence: ItemId): Anchor {
  const { anchor } = clip;

  if ("storyline" in anchor) {
    const after = storylineOf(records, sequence).keyAfter(anchor.position);
    return { ...anchor, position: keyBetween(anchor.position, after) };
  }

  if ("origin" in anchor) return { ...anchor, at: anchor.at + offset };
  const parent = records.items.get(anchor.clip)?.record;
  if (parent?.kind !== "clip") skip("stale", `no clip ${anchor.clip}`);
  const at = anchor.at + flicksToSource(offset, timeBaseOf(records, parent), parent.speed);
  return { ...anchor, at };
}

// Moves the keyframes of `from` at source points `moves` picks to `to`.
function handKeyframes(records: Records, from: ItemId, to: ItemId, moves: (at: number) => boolean) {
  const own = records.keyframes.get(from);
  const target = records.keyframes.get(to) ?? new Map<string, KeyframeRecord>();

  for (const [key, keyframe] of own ?? []) {
    if (!moves(keyframe.at)) continue;
    own?.delete(key);
    if (!target.has(key)) target.set(key, { ...keyframe, target: to });
  }

  if (target.size > 0) records.keyframes.set(to, target);
}

// Moves what a split or a join hands from one piece to the other: the connected items at source
// points `moves` picks, a transition on the cut, and the clip's own keyframes. Returns the items
// moved.
function handOver(records: Records, from: ItemId, to: ItemId, moves: (at: number) => boolean) {
  const moved: ItemId[] = [];

  // A copy, since moving one changes the set.
  for (const dependent of Array.from(records.dependents.get(from) ?? [])) {
    const record = records.items.get(dependent)?.record;
    if (record === undefined) continue;

    if (record.kind === "transition") replace(records, dependent, { ...record, cut: to });
    else if ("clip" in record.anchor && moves(record.anchor.at)) {
      replace(records, dependent, { ...record, anchor: { clip: to, at: record.anchor.at } });
    } else continue;

    moved.push(dependent);
  }

  handKeyframes(records, from, to, moves);
  return moved;
}

// Whether a live storyline item shares the clip's position key after it: a piece can't be put
// between the two, since order within a key is by id.
function tiedAfter(records: Records, id: ItemId, position: string, sequence: ItemId) {
  const line = storylineOf(records, sequence);

  for (let next = line.next(id); next !== undefined; next = line.next(next)) {
    const state = records.items.get(next);
    const record = state?.record;
    if (record === undefined || record.kind === "transition" || !("storyline" in record.anchor))
      break;
    if (record.anchor.position !== position) break;
    if (!state?.removed) return true;
  }

  return false;
}

/** A clip of a sequence to split at a timeline time, and the id its second piece takes. */
type Split = Piece & { sequence: ItemId; at: number; piece: ItemId };

// Where the second piece of a split goes, and how far into the clip it starts.
function splitPoint(records: Records, { id, clip, sequence, at, piece }: Split) {
  const from = start(records, id);
  const wanted = from === undefined ? 0 : at - from;
  if (wanted <= 0 || wanted >= clip.duration) skip("stale", "the clip doesn't cover the time");
  const anchor = guarded(() => pieceAnchor(records, clip, wanted, sequence));
  if ("at" in anchor && !Number.isSafeInteger(anchor.at)) skip("malformed", "a time out of range");

  if ("storyline" in anchor && "storyline" in clip.anchor) {
    if (tiedAfter(records, id, clip.anchor.position, sequence)) {
      skip("structural", "another item shares the clip's position key after it");
    }
  }

  const lands = "storyline" in anchor ? at : startOf(records, piece, { ...clip, anchor }, sequence);
  const offset = lands === undefined || from === undefined ? 0 : lands - from;
  if (offset <= 0 || offset >= clip.duration) skip("stale", "the clip doesn't cover the time");
  return { anchor, offset };
}

/**
 * Splits a clip at a timeline time: it keeps what is before, and a new clip, `piece`, takes what
 * is after. Where the piece's anchor lands, rounded to its anchor's units and snapped to a frame,
 * is where the split falls, so the two pieces always meet. Returns the items changed.
 */
export function splitClip(records: Records, id: ItemId, at: number, piece: ItemId) {
  if (records.items.has(piece)) skip("stale", `${piece} exists`);
  const { state, clip } = liveClip(records, id);
  const { sequence } = state;
  const { anchor, offset } = splitPoint(records, { id, clip, sequence, at, piece });
  const timeBase = timeBaseOf(records, clip);
  const point = guarded(() => clip.in + flicksToSource(offset, timeBase, clip.speed));
  if (!Number.isSafeInteger(point)) skip("malformed", "a source point out of range");
  const first = withFade({ ...clip, duration: offset }, "fadeOut", 0);
  const rest = { ...clip, in: point, duration: clip.duration - offset, anchor };
  const second = withFade(rest, "fadeIn", 0);
  const line = storylineOf(records, sequence);
  if (inStoryline(clip)) line.setDuration(id, offset);
  if ("storyline" in anchor) line.insert(piece, anchor.position, second.duration);
  replace(records, id, first);
  addRecord(records, piece, { record: second, sequence, removed: false });
  const moved = handOver(records, id, piece, (source) => pastSplit(source, point, clip));
  return [id, piece, ...moved];
}

// Whether `next` starts where `first` ends, on the same anchor.
function meets(records: Records, first: Piece, next: Piece) {
  const a = first.clip.anchor;
  const b = next.clip.anchor;
  const end = (start(records, first.id) ?? 0) + first.clip.duration;

  if ("storyline" in a || "storyline" in b) {
    if (!("storyline" in a && "storyline" in b)) return false;
    return storylineOf(records, a.storyline).at(end)?.id === next.id;
  }

  const sameAnchor =
    "origin" in a ? "origin" in b && a.origin === b.origin : "clip" in b && a.clip === b.clip;
  return sameAnchor && start(records, next.id) === end;
}

// Skips joining two clips that aren't pieces of one clip meeting exactly, with nothing between.
function checkJoin(records: Records, first: Piece, next: Piece) {
  const { clip } = first;
  const { clip: other } = next;
  const timeBase = timeBaseOf(records, clip);
  const point = guarded(() => clip.in + flicksToSource(clip.duration, timeBase, clip.speed));
  if (other.in !== point || !meets(records, first, next)) skip("stale", "the pieces don't meet");
  const placed = live(records, records.dependents, first.id);

  if (placed.some((each) => records.items.get(each)?.record.kind === "transition")) {
    skip("structural", "a transition sits on the cut");
  }

  const own = records.keyframes.get(first.id);

  for (const key of records.keyframes.get(next.id)?.keys() ?? []) {
    if (own?.has(key) === true) skip("stale", "both pieces have a keyframe at one source point");
  }
}

/**
 * Joins two pieces of one source that meet exactly, as a split left them, back into the first.
 * Returns the items changed.
 */
export function joinClips(records: Records, id: ItemId, nextId: ItemId) {
  const { state, clip } = liveClip(records, id);
  const { state: nextState, clip: next } = liveClip(records, nextId);
  if (id === nextId) skip("malformed", "a clip joins another");

  if (
    state.sequence !== nextState.sequence ||
    clip.role !== next.role ||
    !same(clip.source, next.source) ||
    !same(clip.speed, next.speed)
  ) {
    skip("structural", "only pieces of one clip join");
  }

  checkJoin(records, { id, clip }, { id: nextId, clip: next });
  const joined = { ...clip, duration: clip.duration + next.duration };
  const record =
    next.audio === undefined ? joined : withFade(joined, "fadeOut", next.audio.fadeOut);
  const line = storylineOf(records, state.sequence);

  if (inStoryline(clip)) {
    line.setDuration(nextId, 0);
    line.setDuration(id, record.duration);
  }

  replace(records, id, record);
  nextState.removed = true;
  return [id, nextId, ...handOver(records, nextId, id, () => true)];
}

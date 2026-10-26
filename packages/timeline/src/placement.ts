// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Where an item goes (docs/architecture.md#anchors): the sequence its anchor puts it in, what a
// clip needs besides, and where it starts, worked out from anchors and durations as layout does,
// never stored.

import type { ItemRecord } from "./document";
import type { ItemId } from "./ids";
import { clipAnchorStart, originAnchorStart, transitionHalves } from "./layout";
import {
  inStoryline,
  live,
  liveItem,
  liveRole,
  liveSequence,
  storylineOf,
  type Records,
} from "./records";
import { skip } from "./skip";
import { FLICKS_PER_SECOND, type Ratio } from "./time";

/** A span of a sequence, in flicks, that a change redraws. */
export type Span = { sequence: ItemId; from: number; to: number };

// Whether sequence `outer` holds a compound clip of `inner`, directly or further down.
function contains(records: Records, outer: ItemId, inner: ItemId, seen = new Set<ItemId>()) {
  if (seen.has(outer)) return false;
  seen.add(outer);

  for (const id of live(records, records.members, outer)) {
    const record = records.items.get(id)?.record;
    if (record?.kind !== "clip" || !("sequence" in record.source)) continue;
    const played = record.source.sequence;
    if (played === inner || contains(records, played, inner, seen)) return true;
  }

  return false;
}

// The sequence of a connected item on a clip, if the clip is a live storyline clip of a sequence.
function clipSequence(records: Records, id: ItemId, clip: ItemId, orphanOk: boolean) {
  const target = records.items.get(clip);
  if (target === undefined || (target.removed && !orphanOk)) skip("stale", `no item ${clip}`);

  if (clip === id || target.record.kind !== "clip" || !inStoryline(target.record)) {
    skip("structural", "connected items anchor to storyline clips");
  }

  return target.sequence;
}

/**
 * The sequence an item in `record` belongs to, if its anchor fits: storyline clips and gaps,
 * connected clips and markers on a storyline clip or the origin, and transitions on a storyline
 * item's end. A restored item may stay on a removed clip, as an orphan.
 */
export function sequenceFor(records: Records, id: ItemId, record: ItemRecord, orphanOk: boolean) {
  if (record.kind === "transition") {
    const cut = liveItem(records, record.cut);
    if (!inStoryline(cut.record)) skip("structural", "a transition's cut is a storyline item");
    return cut.sequence;
  }

  const { anchor } = record;

  if ("storyline" in anchor) {
    if (record.kind === "marker") skip("structural", "a marker is connected, not in a storyline");
    liveSequence(records, anchor.storyline);
    return anchor.storyline;
  }

  if (record.kind === "gap") skip("structural", "a gap is in a storyline");

  if ("origin" in anchor) {
    liveSequence(records, anchor.origin);
    return anchor.origin;
  }

  return clipSequence(records, id, anchor.clip, orphanOk);
}

// The kind of media a clip's asset stream or generator gives, or undefined for a compound clip.
function mediaKind(records: Records, record: Extract<ItemRecord, { kind: "clip" }>) {
  const { source } = record;
  if ("generator" in source) return "video";
  if (!("asset" in source)) return undefined;
  const asset = records.assets.get(source.asset);
  if (asset === undefined || asset.removed) skip("stale", `no asset ${source.asset}`);
  const stream = asset.record.streams.find((s) => s.index === source.stream);
  if (stream === undefined) skip("stale", `no stream ${source.stream} in ${source.asset}`);
  return stream.kind === "audio" ? "audio" : "video";
}

/**
 * What a clip needs besides its anchor: a role of its sequence that takes its kind of media, its
 * asset and stream, and for a new compound clip, a sequence that doesn't hold this one (a clip's
 * source never changes, so that is checked only when it is added or restored).
 */
export function checkClip(
  records: Records,
  record: ItemRecord,
  sequence: ItemId,
  placing: boolean,
) {
  if (record.kind !== "clip") return;
  const role = liveRole(records, record.role);
  if (role.record.sequence !== sequence) skip("structural", "a clip's role is of its sequence");
  const { source } = record;
  const kind = mediaKind(records, record);

  if (placing && "sequence" in source) {
    liveSequence(records, source.sequence);

    if (source.sequence === sequence || contains(records, source.sequence, sequence)) {
      skip("structural", "a compound clip would contain itself");
    }
  }

  if (kind !== undefined && kind !== role.record.kind) {
    skip("structural", `a ${kind} clip in a ${role.record.kind} role`);
  }
}

/** The time base a clip's source points are in: its stream's, or flicks'. */
export function timeBaseOf(records: Records, record: ItemRecord): Ratio {
  if (record.kind !== "clip" || !("asset" in record.source)) return [1, FLICKS_PER_SECOND];
  const { asset: id, stream } = record.source;
  const found = records.assets.get(id)?.record.streams.find((s) => s.index === stream);
  return found?.timeBase ?? [1, FLICKS_PER_SECOND];
}

// A sequence's rate when `record` is video, which snaps to frames, or undefined for audio.
function snapRate(records: Records, record: ItemRecord, sequence: ItemId): Ratio | undefined {
  if (record.kind !== "clip" || records.roles.get(record.role)?.record.kind !== "video")
    return undefined;
  return records.sequences.get(sequence)?.record.rate;
}

// The time layout gives, or undefined for one past the safe integers, which isn't shown.
function shown(layout: () => number) {
  try {
    return layout();
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

// Where a transition starts: half its length before the end of its cut, if the cut is shown.
function transitionStart(records: Records, cut: ItemId, duration: number, sequence: ItemId) {
  const state = records.items.get(cut);
  if (state === undefined || state.removed || !inStoryline(state.record)) return undefined;
  const rate = records.sequences.get(sequence)?.record.rate;
  if (rate === undefined) return undefined;
  const end = storylineOf(records, sequence).start(cut) + state.record.duration;
  return end - transitionHalves(duration, rate).before;
}

/**
 * Where an item with `record` starts, or undefined when it isn't shown: a transition on a removed
 * cut, or a time past the safe integers.
 */
export function startOf(records: Records, id: ItemId, record: ItemRecord, sequence: ItemId) {
  const line = storylineOf(records, sequence);
  if (record.kind === "transition")
    return transitionStart(records, record.cut, record.duration, sequence);
  const { anchor } = record;
  if ("storyline" in anchor) return line.start(id);
  const rate = snapRate(records, record, sequence);
  if ("origin" in anchor) return shown(() => originAnchorStart(anchor.at, rate));
  const clip = records.items.get(anchor.clip)?.record;
  if (clip?.kind !== "clip") return undefined;
  const anchorClip = {
    start: line.start(anchor.clip),
    in: clip.in,
    speed: clip.speed,
    timeBase: timeBaseOf(records, clip),
  };
  return shown(() => clipAnchorStart(anchorClip, anchor.at, rate));
}

/** Where an item starts in its sequence, in flicks, or undefined when it isn't shown. */
export function start(records: Records, id: ItemId): number | undefined {
  const state = records.items.get(id);
  if (state === undefined || state.removed) return undefined;
  return startOf(records, id, state.record, state.sequence);
}

/** A connected item must start and end at a safe integer to be placed. */
export function checkPlaced(records: Records, id: ItemId, record: ItemRecord, sequence: ItemId) {
  if (inStoryline(record) || record.kind === "transition") return;
  const from = startOf(records, id, record, sequence);

  if (from === undefined || !Number.isSafeInteger(from + record.duration)) {
    skip("malformed", "a time out of range");
  }
}

/**
 * What an item's change can redraw: from its start, to the end of time if it moves others (a
 * storyline item moves what follows, a connected clip can push later clips of its role to other
 * lanes), and the same for the items it places.
 */
export function extents(records: Records, id: ItemId): Span[] {
  const state = records.items.get(id);
  const from = start(records, id);
  if (state === undefined || from === undefined) return [];
  const { record, sequence } = state;
  const end =
    record.kind === "clip" || inStoryline(record)
      ? Number.POSITIVE_INFINITY
      : from + record.duration;
  const own = { sequence, from, to: end };
  if (!inStoryline(record)) return [own];
  return [own, ...live(records, records.dependents, id).flatMap((each) => extents(records, each))];
}

/** Where an item plays, if it is shown. */
export function playing(records: Records, id: ItemId): Span[] {
  const state = records.items.get(id);
  const from = start(records, id);
  if (state === undefined || from === undefined) return [];
  return [{ sequence: state.sequence, from, to: from + state.record.duration }];
}

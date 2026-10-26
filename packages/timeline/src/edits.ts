// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The operations that add, set, move, remove and restore one record
// (docs/architecture.md#applying): each checks itself against the document as it is, and skips
// before changing anything when it doesn't fit.

import {
  effect as effectSchema,
  item as itemSchema,
  role as roleSchema,
  sequence as sequenceSchema,
  type Anchor,
  type Asset,
  type EffectRecord,
  type ItemRecord,
  type KeyframeRecord,
  type RoleRecord,
  type SequenceRecord,
  type Value,
} from "./document";
import type { ItemId } from "./ids";
import { ANIMATED, withLeaf } from "./leaf";
import { checkClip, checkPlaced, sequenceFor } from "./placement";
import {
  add,
  addRecord,
  inStoryline,
  keyframeKey,
  live,
  liveClip,
  liveEffect,
  liveItem,
  liveRole,
  liveSequence,
  putKeyframe,
  replace,
  storylineOf,
  type Records,
} from "./records";
import { checked, checkRate, guarded, skip } from "./skip";
import { createStoryline } from "./storyline";

/** A leaf to set: its path in the record, and its new value. */
export type Leaf = { path: string; value: Value };

export function addItem(records: Records, id: ItemId, record: ItemRecord) {
  if (records.items.has(id)) skip("stale", `${id} exists`);
  const sequence = sequenceFor(records, id, record, false);
  checkClip(records, record, sequence, true);
  checkPlaced(records, id, record, sequence);

  if (record.kind !== "transition" && "storyline" in record.anchor) {
    const { position } = record.anchor;
    guarded(() => storylineOf(records, sequence).insert(id, position, record.duration));
  }

  addRecord(records, id, { record, sequence, removed: false });
}

export function setItem(records: Records, id: ItemId, { path, value }: Leaf) {
  const state = liveItem(records, id);
  const record = checked(itemSchema, withLeaf(state.record, state.record.kind, path, value));
  checkClip(records, record, state.sequence, false);
  checkPlaced(records, id, record, state.sequence);
  if (inStoryline(record))
    guarded(() => storylineOf(records, state.sequence).setDuration(id, record.duration));
  replace(records, id, record);
}

export function moveItem(records: Records, id: ItemId, anchor: Anchor) {
  const state = liveItem(records, id);
  if (state.record.kind === "transition") skip("malformed", "a transition is placed by its cut");
  const record = { ...state.record, anchor };
  const sequence = sequenceFor(records, id, record, false);
  if (sequence !== state.sequence) skip("structural", "an item moves within its sequence");
  checkPlaced(records, id, record, sequence);
  const was = inStoryline(state.record);

  if (was && !("storyline" in anchor) && live(records, records.dependents, id).length > 0) {
    skip("structural", "a storyline item leaves the storyline while items are placed by it");
  }

  const line = storylineOf(records, sequence);
  if (was && "storyline" in anchor) line.move(id, anchor.position);
  else if ("storyline" in anchor) guarded(() => line.insert(id, anchor.position, record.duration));
  else if (was) line.remove(id);
  replace(records, id, record);
}

/**
 * Removes an item. A removed storyline item stays in the storyline with no length, so items
 * connected to it still sit where it was.
 */
export function removeItem(records: Records, id: ItemId) {
  const state = liveItem(records, id);
  if (inStoryline(state.record)) storylineOf(records, state.sequence).setDuration(id, 0);
  state.removed = true;
}

export function restoreItem(records: Records, id: ItemId) {
  const state = records.items.get(id);
  if (state === undefined || !state.removed) skip("stale", `${id} isn't removed`);
  const { record, sequence } = state;
  liveSequence(records, sequence);
  sequenceFor(records, id, record, true);
  checkClip(records, record, sequence, true);
  checkPlaced(records, id, record, sequence);
  if (inStoryline(record))
    guarded(() => storylineOf(records, sequence).setDuration(id, record.duration));
  state.removed = false;
}

export function addAsset(records: Records, record: Asset) {
  const existing = records.assets.get(record.id);
  if (existing !== undefined && !existing.removed) skip("stale", `${record.id} exists`);
  records.assets.set(record.id, { record, removed: false });
}

export function removeAsset(records: Records, id: string) {
  const state = records.assets.get(id);
  if (state === undefined || state.removed) skip("stale", `no asset ${id}`);
  if (live(records, records.users, id).length > 0) skip("structural", "an asset still in use");
  state.removed = true;
}

export function addSequence(records: Records, id: ItemId, record: SequenceRecord) {
  if (records.sequences.has(id)) skip("stale", `${id} exists`);
  checkRate(record.rate);
  records.sequences.set(id, { record, removed: false, storyline: createStoryline() });
}

export function setSequence(records: Records, id: ItemId, { path, value }: Leaf) {
  const state = liveSequence(records, id);
  const record = checked(sequenceSchema, withLeaf(state.record, "sequence", path, value));
  checkRate(record.rate);
  state.record = record;
}

export function removeSequence(records: Records, id: ItemId) {
  const state = liveSequence(records, id);
  if (live(records, records.members, id).length > 0)
    skip("structural", "a sequence still holds items");
  if (live(records, records.users, id).length > 0)
    skip("structural", "a sequence still played by a compound clip");
  state.removed = true;
}

export function addRole(records: Records, id: ItemId, record: RoleRecord) {
  if (records.roles.has(id)) skip("stale", `${id} exists`);
  liveSequence(records, record.sequence);
  records.roles.set(id, { record, removed: false });
}

export function setRole(records: Records, id: ItemId, { path, value }: Leaf) {
  const state = liveRole(records, id);
  state.record = checked(roleSchema, withLeaf(state.record, "role", path, value));
}

export function removeRole(records: Records, id: ItemId) {
  const state = liveRole(records, id);
  if (live(records, records.users, id).length > 0) skip("structural", "a role still in use");
  state.removed = true;
}

export function addEffect(records: Records, id: ItemId, record: EffectRecord) {
  if (records.effects.has(id)) skip("stale", `${id} exists`);
  liveClip(records, record.clip);
  records.effects.set(id, { record, removed: false });
  add(records.chains, record.clip, id);
}

export function removeEffect(records: Records, id: ItemId) {
  liveEffect(records, id).removed = true;
}

// Whether a parameter's new value is of the type its old one was.
const sameType = (a: Value, b: Value) =>
  typeof a === typeof b && Array.isArray(a) === Array.isArray(b);

export function setEffect(records: Records, id: ItemId, { path, value }: Leaf) {
  const state = liveEffect(records, id);
  const old = path.startsWith("params.") ? state.record.params[path.slice(7)] : undefined;
  if (old !== undefined && !sameType(old, value)) skip("malformed", `${path} takes another type`);
  state.record = checked(effectSchema, withLeaf(state.record, "effect", path, value));
}

// A keyframe's target and param must name a live value of its type: an effect's parameter, or an
// animated field of a clip.
function checkKeyframe(records: Records, { target, param, value }: KeyframeRecord) {
  const effect = records.effects.get(target);

  if (effect !== undefined) {
    liveEffect(records, target);
    const old = effect.record.params[param];
    if (old === undefined) skip("stale", `no parameter ${param} in ${target}`);
    if (!sameType(old, value)) skip("malformed", `${param} takes another type`);
    return;
  }

  const { clip } = liveClip(records, target);
  if (!ANIMATED.test(param)) skip("malformed", `${param} isn't animated`);
  checked(itemSchema, withLeaf(clip, "clip", param, value));
}

export function setKeyframe(records: Records, keyframe: KeyframeRecord) {
  checkKeyframe(records, keyframe);
  putKeyframe(records, keyframe);
}

export function removeKeyframe(
  records: Records,
  { target, param, at }: { target: ItemId; param: string; at: number },
) {
  if (records.keyframes.get(target)?.delete(keyframeKey(param, at)) !== true) {
    skip("stale", `no keyframe of ${param} at ${at} on ${target}`);
  }
}

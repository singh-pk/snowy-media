// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A project's records as applying keeps them (docs/architecture.md#the-document): every record by
// id, removed ones included, so an id stays taken and a removed record keeps its state; the
// indexes kept in step with them; and looking up a live record, which skips an operation naming
// one that isn't.

import type {
  Asset,
  EffectRecord,
  ItemRecord,
  KeyframeRecord,
  RoleRecord,
  SequenceRecord,
} from "./document";
import type { ItemId } from "./ids";
import { skip } from "./skip";
import type { createStoryline } from "./storyline";

type SequenceState = {
  record: SequenceRecord;
  removed: boolean;
  storyline: ReturnType<typeof createStoryline>;
};

export type RoleState = { record: RoleRecord; removed: boolean };
export type ItemState = { record: ItemRecord; sequence: ItemId; removed: boolean };
export type AssetState = { record: Asset; removed: boolean };
export type EffectState = { record: EffectRecord; removed: boolean };
export type Clip = Extract<ItemRecord, { kind: "clip" }>;

/**
 * Each author's applied seqs as sorted, disjoint [first, last] runs. An author's seqs come mostly
 * in order, so there are few runs, and a snapshot shares them instead of copying every batch.
 * Runs are never changed, only replaced.
 */
export type Runs = ReadonlyArray<readonly [number, number]>;

/** A project's document as applying changes it. */
export type Records = {
  name: string;
  assets: Map<string, AssetState>;
  sequences: Map<ItemId, SequenceState>;
  roles: Map<ItemId, RoleState>;
  items: Map<ItemId, ItemState>;
  // Indexes kept as items change, removed items included, so checks don't scan every item: the
  // items in each sequence, the items placed by each storyline item, and the clips using each
  // role, asset or played sequence.
  members: Map<ItemId, Set<ItemId>>;
  dependents: Map<string, Set<ItemId>>;
  users: Map<string, Set<ItemId>>;
  effects: Map<ItemId, EffectState>;
  // Each clip's effects, removed ones included.
  chains: Map<ItemId, Set<ItemId>>;
  // Each target's keyframes, by param and source point.
  keyframes: Map<ItemId, Map<string, KeyframeRecord>>;
  // The batches applied, so a merge brings each batch once, however the branches were merged.
  batches: Map<string, Runs>;
};

/** An empty document. */
export function createRecords(): Records {
  return {
    name: "",
    assets: new Map(),
    sequences: new Map(),
    roles: new Map(),
    items: new Map(),
    members: new Map(),
    dependents: new Map(),
    users: new Map(),
    effects: new Map(),
    chains: new Map(),
    keyframes: new Map(),
    batches: new Map(),
  };
}

/** Forgets every record, to load a snapshot's again. */
export function clear(records: Records) {
  const { assets, sequences, roles, items, members, dependents, users } = records;
  for (const index of [assets, sequences, roles, items, members, dependents, users]) index.clear();
  for (const index of [records.effects, records.chains, records.keyframes]) index.clear();
}

const holds = (runs: Runs | undefined, seq: number) =>
  runs?.some(([first, end]) => first <= seq && seq <= end) === true;

// `runs` with `seq` added, joining the runs it meets.
function withSeq(runs: Runs, seq: number): Runs {
  const before = runs.filter(([, end]) => end < seq - 1);
  const after = runs.filter(([first]) => first > seq + 1);
  const touching = runs.filter(([first, end]) => first <= seq + 1 && end >= seq - 1);
  const first = Math.min(seq, ...touching.map(([from]) => from));
  const end = Math.max(seq, ...touching.map(([, to]) => to));
  return [...before, [first, end], ...after];
}

/** Whether a batch is applied to the document, itself or by a merge. */
export const has = (records: Records, batch: { author: string; seq: number }) =>
  holds(records.batches.get(batch.author), batch.seq);

/** Records a batch as applied. */
export function hold(records: Records, batch: { author: string; seq: number }) {
  const { batches } = records;
  batches.set(batch.author, withSeq(batches.get(batch.author) ?? [], batch.seq));
}

/** Whether a record is an item in a storyline, rather than connected or a transition. */
export const inStoryline = (record: ItemRecord) =>
  record.kind !== "transition" && "storyline" in record.anchor;

/** Strings in UTF-16 code unit order, never by locale, as storylines order position keys. */
export const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// The record an item depends on to be placed: a connected item's clip, a transition's cut.
function dependsOn(record: ItemRecord) {
  if (record.kind === "transition") return record.cut;
  return "clip" in record.anchor ? record.anchor.clip : undefined;
}

// The records a clip uses: its role, and its asset or the sequence it plays.
function usedBy(record: ItemRecord) {
  if (record.kind !== "clip") return [];
  const { source } = record;
  if ("asset" in source) return [record.role, source.asset];
  return "sequence" in source ? [record.role, source.sequence] : [record.role];
}

/** Adds `id` to the set `index` keeps under `key`. */
export function add(index: Map<string, Set<ItemId>>, key: string, id: ItemId) {
  const set = index.get(key) ?? new Set();
  set.add(id);
  index.set(key, set);
}

/** The live items an index keeps under `key`. */
export function live(records: Records, index: Map<string, Set<ItemId>>, key: string) {
  return [...(index.get(key) ?? [])].filter((id) => records.items.get(id)?.removed === false);
}

/** Indexes what an item's record depends on and uses. */
function link(records: Records, id: ItemId, record: ItemRecord) {
  const target = dependsOn(record);
  if (target !== undefined) add(records.dependents, target, id);
  for (const used of usedBy(record)) add(records.users, used, id);
}

function unlink(records: Records, id: ItemId, record: ItemRecord) {
  const target = dependsOn(record);
  if (target !== undefined) records.dependents.get(target)?.delete(id);
  for (const used of usedBy(record)) records.users.get(used)?.delete(id);
}

/** Gives item `id` a new record, keeping the indexes in step. */
export function replace(records: Records, id: ItemId, record: ItemRecord) {
  const state = records.items.get(id);
  if (state === undefined) throw new RangeError(`no item ${id}`);
  unlink(records, id, state.record);
  state.record = record;
  link(records, id, record);
}

/** A new item, placed in its sequence's indexes. */
export function addRecord(records: Records, id: ItemId, state: ItemState) {
  records.items.set(id, state);
  add(records.members, state.sequence, id);
  link(records, id, state.record);
}

export function liveSequence(records: Records, id: ItemId) {
  const state = records.sequences.get(id);
  if (state === undefined || state.removed) skip("stale", `no sequence ${id}`);
  return state;
}

export function liveItem(records: Records, id: ItemId) {
  const state = records.items.get(id);
  if (state === undefined || state.removed) skip("stale", `no item ${id}`);
  return state;
}

export function liveRole(records: Records, id: ItemId) {
  const state = records.roles.get(id);
  if (state === undefined || state.removed) skip("stale", `no role ${id}`);
  return state;
}

export function liveClip(records: Records, id: ItemId) {
  const state = liveItem(records, id);
  if (state.record.kind !== "clip") skip("structural", `${id} isn't a clip`);
  return { state, clip: state.record };
}

/** A live effect of a live clip. */
export function liveEffect(records: Records, id: ItemId) {
  const state = records.effects.get(id);
  if (state === undefined || state.removed) skip("stale", `no effect ${id}`);
  liveClip(records, state.record.clip);
  return state;
}

/** A sequence's storyline, removed or not. */
export function storylineOf(records: Records, id: ItemId) {
  const state = records.sequences.get(id);
  if (state === undefined) throw new RangeError(`no sequence ${id}`);
  return state.storyline;
}

export const keyframeKey = (param: string, at: number) => `${param} ${at}`;

/** Sets a keyframe on its target, in place of one of its param at its source point. */
export function putKeyframe(records: Records, keyframe: KeyframeRecord) {
  const own = records.keyframes.get(keyframe.target) ?? new Map<string, KeyframeRecord>();
  own.set(keyframeKey(keyframe.param, keyframe.at), keyframe);
  records.keyframes.set(keyframe.target, own);
}

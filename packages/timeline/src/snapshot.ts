// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A project's snapshot: its whole state as plain data, which another project starts from and a
// revert goes back to (docs/architecture.md#undo-revert-and-going-back). Records are shared with
// the document, never copied, since applying replaces a record rather than changing it.

import type { KeyframeRecord, SequenceRecord } from "./document";
import type { ItemId } from "./ids";
import {
  add,
  addRecord,
  clear,
  putKeyframe,
  storylineOf,
  type AssetState,
  type EffectState,
  type ItemState,
  type Records,
  type RoleState,
  type Runs,
} from "./records";
import { createStoryline } from "./storyline";

export type Snapshot = {
  name: string;
  assets: AssetState[];
  sequences: Array<{ id: ItemId; record: SequenceRecord; removed: boolean }>;
  roles: Array<RoleState & { id: ItemId }>;
  items: Array<ItemState & { id: ItemId }>;
  effects: Array<EffectState & { id: ItemId }>;
  keyframes: KeyframeRecord[];
  /** Every batch applied to the document, merged ones included: each author's runs of seqs. */
  batches: Array<{ author: string; runs: Runs }>;
};

const byId = (state: { id: ItemId }) => state.id;

// `target`'s states, plus each one only `now` has, marked removed, so a revert keeps its id taken.
function withRemoved<T extends { removed: boolean }>(
  target: T[],
  now: T[],
  idOf: (state: T) => string,
) {
  const kept = new Set(target.map(idOf));
  const states = [...target];

  for (const state of now) {
    if (!kept.has(idOf(state))) states.push({ ...state, removed: true });
  }

  return states;
}

export function snapshotOf(records: Records): Snapshot {
  const state: Snapshot = {
    name: records.name,
    assets: [],
    sequences: [],
    roles: [],
    items: [],
    effects: [],
    keyframes: [],
    batches: [...records.batches].map(([author, runs]) => ({ author, runs })),
  };
  for (const { record, removed } of records.assets.values()) state.assets.push({ record, removed });
  for (const [id, { record, removed }] of records.sequences)
    state.sequences.push({ id, record, removed });
  for (const [id, { record, removed }] of records.roles) state.roles.push({ id, record, removed });

  for (const [id, { record, sequence, removed }] of records.items) {
    state.items.push({ id, record, sequence, removed });
  }

  for (const [id, { record, removed }] of records.effects)
    state.effects.push({ id, record, removed });
  for (const own of records.keyframes.values()) state.keyframes.push(...own.values());
  return state;
}

/**
 * Takes a snapshot's state into an empty document, building the indexes and storylines again. A
 * removed storyline item gets a length of 0, as removing it had left it.
 */
export function load(records: Records, state: Snapshot) {
  records.name = state.name;
  for (const { author, runs } of state.batches) records.batches.set(author, runs);
  for (const asset of state.assets) records.assets.set(asset.record.id, { ...asset });

  for (const { id, record, removed } of state.sequences) {
    records.sequences.set(id, { record, removed, storyline: createStoryline() });
  }

  for (const { id, ...role } of state.roles) records.roles.set(id, role);

  for (const { id, ...rest } of state.items) {
    const { record, sequence, removed } = rest;
    addRecord(records, id, { record, sequence, removed });
    if (record.kind === "transition" || !("storyline" in record.anchor)) continue;
    const duration = removed ? 0 : record.duration;
    storylineOf(records, sequence).insert(id, record.anchor.position, duration);
  }

  for (const { id, ...effect } of state.effects) {
    records.effects.set(id, effect);
    add(records.chains, effect.record.clip, id);
  }

  for (const keyframe of state.keyframes) putKeyframe(records, keyframe);
}

/**
 * Sets the document back to a snapshot's state; returns the ids of every record. What the
 * snapshot doesn't have is removed, not forgotten, so its id stays taken and its state kept.
 */
export function revertTo(records: Records, target: Snapshot): ItemId[] {
  const now = snapshotOf(records);
  const state: Snapshot = {
    name: target.name,
    assets: withRemoved(target.assets, now.assets, ({ record }) => record.id),
    sequences: withRemoved(target.sequences, now.sequences, byId),
    roles: withRemoved(target.roles, now.roles, byId),
    items: withRemoved(target.items, now.items, byId),
    effects: withRemoved(target.effects, now.effects, byId),
    keyframes: target.keyframes,
    // The batches stay applied: merging one again would bring back what the revert took away.
    batches: now.batches,
  };
  clear(records);
  load(records, state);
  return [
    ...state.sequences.map(byId),
    ...state.roles.map(byId),
    ...state.items.map(byId),
    ...state.effects.map(byId),
    ...state.assets.map(({ record }) => record.id),
  ];
}

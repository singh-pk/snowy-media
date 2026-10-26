// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// What a peer reads of a document (docs/architecture.md#queries-and-the-render-plan): items with
// their places, storylines, transitions, lanes, effect chains and keyframes, each in an order that
// depends only on the document, never on the order records arrived in.

import type { ItemId } from "./ids";
import { assignLanes } from "./layout";
import { start } from "./placement";
import { byCodeUnit, inStoryline, live, storylineOf, type Records } from "./records";
import type { Range } from "./apply";

const present = (records: Records, id: ItemId) => records.items.get(id)?.removed === false;

/** An item's record and state, or undefined for an id the project never had. */
export function itemOf(records: Records, id: ItemId) {
  const state = records.items.get(id);
  if (state === undefined) return undefined;
  const { record } = state;
  const anchoredTo =
    record.kind !== "transition" && "clip" in record.anchor ? record.anchor.clip : undefined;
  const orphaned = anchoredTo !== undefined && records.items.get(anchoredTo)?.removed === true;
  return { id, ...record, sequence: state.sequence, removed: state.removed, orphaned };
}

/**
 * A sequence's live storyline items in order, each with its start and duration; with `range`,
 * only those that play in it or start at its end, found from the item at its start.
 */
export function storylineItems(records: Records, sequence: ItemId, range?: Range) {
  const line = storylineOf(records, sequence);
  if (range === undefined) return [...line.items()].filter(({ id }) => present(records, id));
  const found: Array<{ id: ItemId; start: number; duration: number }> = [];
  const first = line.at(Math.max(range.from, 0));
  let id = first?.id;
  let from = first?.start ?? 0;

  while (id !== undefined && from <= range.to) {
    const shown = present(records, id);
    const duration = shown ? (records.items.get(id)?.record.duration ?? 0) : 0;
    if (shown) found.push({ id, start: from, duration });
    from += duration;
    id = line.next(id);
  }

  return found;
}

/** The live storyline item before a storyline item, with its start and duration, if any. */
export function itemBefore(records: Records, id: ItemId) {
  const state = records.items.get(id);
  if (state === undefined) return undefined;
  const line = storylineOf(records, state.sequence);
  let found = line.has(id) ? line.previous(id) : undefined;
  while (found !== undefined && !present(records, found)) found = line.previous(found);
  if (found === undefined) return undefined;
  const duration = records.items.get(found)?.record.duration ?? 0;
  return { id: found, start: line.start(found), duration };
}

/** The live transitions on the end of a storyline item, by id. */
export function transitions(records: Records, cut: ItemId) {
  const found = [];

  for (const id of live(records, records.dependents, cut)) {
    const record = records.items.get(id)?.record;
    if (record?.kind === "transition") found.push(Object.assign({ id }, record));
  }

  return found.toSorted((a, b) => byCodeUnit(a.id, b.id));
}

/** Each shown connected clip of a role, with its start, duration and lane. */
export function connected(records: Records, role: ItemId) {
  const placed = [];

  for (const id of live(records, records.users, role)) {
    const record = records.items.get(id)?.record;
    if (record?.kind !== "clip" || inStoryline(record)) continue;
    const from = start(records, id);
    if (from === undefined || !Number.isSafeInteger(from + record.duration)) continue;
    placed.push({ id, start: from, duration: record.duration, lane: record.lane });
  }

  const assigned = assignLanes(placed);
  for (const each of placed) each.lane = assigned.get(each.id) ?? each.lane;
  return placed;
}

/** A clip's live effects in chain order, by position and then id, each with its id. */
export function chain(records: Records, clip: ItemId) {
  const found = [];

  for (const id of records.chains.get(clip) ?? []) {
    const state = records.effects.get(id);
    if (state !== undefined && !state.removed) found.push({ id, ...state.record });
  }

  return found.toSorted((a, b) =>
    a.position === b.position ? byCodeUnit(a.id, b.id) : byCodeUnit(a.position, b.position),
  );
}

/** A sequence's live roles, each with its id, in order, by `order` and then id. */
export function rolesOf(records: Records, sequence: ItemId) {
  return [...records.roles]
    .filter(([, state]) => !state.removed && state.record.sequence === sequence)
    .map(([id, { record }]) => Object.assign({ id }, record))
    .toSorted((a, b) =>
      a.order === b.order ? byCodeUnit(a.id, b.id) : byCodeUnit(a.order, b.order),
    );
}

/** The keyframes on a clip or effect, by param and then source point. */
export function keyframesOf(records: Records, target: ItemId) {
  return [...(records.keyframes.get(target)?.values() ?? [])].toSorted((a, b) =>
    a.param === b.param ? a.at - b.at : byCodeUnit(a.param, b.param),
  );
}

/** The record with an id, of any kind, and whether it is removed. */
export function recordOf(
  records: Records,
  id: string,
): { record: object; removed: boolean } | undefined {
  const { items, sequences, roles, effects, assets } = records;
  const found = items.get(id) ?? sequences.get(id) ?? roles.get(id) ?? effects.get(id);
  const { record, removed } = found ?? assets.get(id) ?? {};
  return record === undefined ? undefined : { record, removed: removed === true };
}

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A project's document, changed only by applying batches (docs/architecture.md#applying). An
// operation that doesn't fit is skipped, never half applied, so a buggy or hostile peer can't break
// anyone's document and every peer skips the same. No clock, no random numbers, no locale.

import { apply, type Range, type Resolver } from "./apply";
import type { Batch } from "./batch";
import type { ItemRecord } from "./document";
import type { ItemId } from "./ids";
import { start, timeBaseOf } from "./placement";
import * as query from "./queries";
import { createRecords, has } from "./records";
import { load, snapshotOf, type Snapshot } from "./snapshot";

export type { Applied, Range, Resolver } from "./apply";
export { leafOf } from "./leaf";
export type { Snapshot } from "./snapshot";

export type Document = Omit<ReturnType<typeof createProject>, "apply">;

/** A project's document, empty or as a snapshot left it. */
export function createProject(initial?: Snapshot) {
  const records = createRecords();
  if (initial !== undefined) load(records, initial);

  return {
    /**
     * Applies a batch's operations in order, skipping any that doesn't fit the document. `history`
     * resolves reverts and merges; without it, reverts, merges and the other branch operations are
     * skipped.
     */
    apply: (batch: Pick<Batch, "author" | "seq" | "ops">, history?: Resolver) =>
      apply(records, batch, history),
    /** The whole state, to start another project from. Records are shared, never changed. */
    snapshot: () => snapshotOf(records),
    /** Whether a batch is applied to the document, itself or by a merge. */
    has: (batch: { author: string; seq: number }) => has(records, batch),
    /** The record with an id, of any kind, and whether it is removed. */
    record: (id: string) => query.recordOf(records, id),
    /** An item's record and state, or undefined for an id the project never had. */
    item: (id: ItemId) => query.itemOf(records, id),
    /** Where an item starts in its sequence, in flicks, or undefined when it isn't shown. */
    start: (id: ItemId) => start(records, id),
    /**
     * A sequence's live storyline items in order, each with its start and duration; with
     * `range`, only those that play in it or start at its end.
     */
    storyline: (sequence: ItemId, range?: Range) => query.storylineItems(records, sequence, range),
    /** The lane of each shown connected clip of a role. */
    lanes: (role: ItemId) =>
      new Map(query.connected(records, role).map(({ id, lane }) => [id, lane])),
    /** Each shown connected clip of a role, with its start, duration and lane. */
    connected: (role: ItemId) => query.connected(records, role),
    /** The live storyline item before a storyline item, with its start and duration, if any. */
    itemBefore: (id: ItemId) => query.itemBefore(records, id),
    /** The live transitions on the end of a storyline item, by id. */
    transitions: (cut: ItemId) => query.transitions(records, cut),
    /** A sequence's length in flicks: its storyline's duration, or 0 for an unknown sequence. */
    length: (sequence: ItemId) => records.sequences.get(sequence)?.storyline.duration() ?? 0,
    /** The time base a clip's source points are in: its stream's, or flicks'. */
    timeBase: (record: ItemRecord) => timeBaseOf(records, record),
    name: () => records.name,
    sequence: (id: ItemId) => records.sequences.get(id)?.record,
    role: (id: ItemId) => records.roles.get(id)?.record,
    /** A sequence's live roles, each with its id, in order, by `order` and then id. */
    roles: (sequence: ItemId) => query.rolesOf(records, sequence),
    asset: (id: string) => records.assets.get(id)?.record,
    /** A clip's live effects in chain order, by position and then id, each with its id. */
    effects: (clip: ItemId) => query.chain(records, clip),
    /** The keyframes on a clip or effect, by param and then source point. */
    keyframes: (target: ItemId) => query.keyframesOf(records, target),
  };
}

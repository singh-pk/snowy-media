// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Applying a batch (docs/architecture.md#applying): each operation is checked against the document
// as it is then and skipped if it doesn't fit, never half applied. Applying uses only the batch and
// the document: no clock, no random numbers, no locale.

import type { Batch } from "./batch";
import { joinClips, splitClip } from "./cuts";
import type { EntryRef } from "./document";
import * as edit from "./edits";
import { itemId, type ItemId } from "./ids";
import { extents, playing, type Span } from "./placement";
import { has, hold, type Records } from "./records";
import { skip, Skipped, type Skip } from "./skip";
import { revertTo, type Snapshot } from "./snapshot";

type Operation = Batch["ops"][number];
type Merge = Extract<Operation, { op: "branch.merge" }>;
type Applicable = Pick<Batch, "author" | "seq" | "ops">;

/** A time range of a sequence that changed, in flicks; infinite at an end that reaches all the way. */
export type Range = { from: number; to: number };

/** `index` is the merge's index in the batch applied. */
type Merged = { index: number; batch: Applicable; skipped: Skip[] };

export type Applied = {
  skipped: Skip[];
  /** The batches merges brought that the document didn't have, in the order applied. */
  merged: Merged[];
  /** The ids of the records the batch changed, in the order it first changed them. */
  changed: ItemId[];
  /** Per sequence, the time range to redraw. */
  ranges: Map<ItemId, Range>;
};

/**
 * What applying needs from the history: the branch applied to, the document at an entry of it,
 * for a revert, and the batches a merge brings, in their branch's order; "missing" while this peer
 * doesn't have every entry the merge names, "stale" for entries it never will.
 */
export type Resolver = {
  branch: Batch["branch"];
  at: (ref: EntryRef) => Snapshot | undefined;
  merged: (op: Merge) => readonly Applicable[] | "missing" | "stale";
};

const EVERYTHING = { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY };

// Undefined for an operation of another kind.
function applyRecord(records: Records, op: Operation, id: ItemId): ItemId[] | undefined {
  switch (op.op) {
    case "project.set":
      records.name = op.name;
      return [];
    case "asset.add":
      edit.addAsset(records, op.asset);
      return [op.asset.id];
    case "asset.remove":
      edit.removeAsset(records, op.id);
      return [op.id];
    case "sequence.add":
      edit.addSequence(records, id, op.sequence);
      return [id];
    case "sequence.set":
      edit.setSequence(records, op.id, op);
      return [op.id];
    case "sequence.remove":
      edit.removeSequence(records, op.id);
      return [op.id];
    case "role.add":
      edit.addRole(records, id, op.role);
      return [id];
    case "role.set":
      edit.setRole(records, op.id, op);
      return [op.id];
    case "role.remove":
      edit.removeRole(records, op.id);
      return [op.id];
    case "effect.add":
      edit.addEffect(records, id, op.effect);
      return [id];
    case "effect.set":
      edit.setEffect(records, op.id, op);
      return [op.id];
    case "effect.remove":
      edit.removeEffect(records, op.id);
      return [op.id];
    default:
      return undefined;
  }
}

// Undefined for an operation of another kind.
function applyItem(records: Records, op: Operation, id: ItemId): ItemId[] | undefined {
  switch (op.op) {
    case "item.add":
      edit.addItem(records, id, op.item);
      return [id];
    case "item.set":
      edit.setItem(records, op.id, op);
      return [op.id];
    case "item.move":
      edit.moveItem(records, op.id, op.anchor);
      return [op.id];
    case "item.remove":
      edit.removeItem(records, op.id);
      return [op.id];
    case "item.restore":
      edit.restoreItem(records, op.id);
      return [op.id];
    case "clip.split":
      return splitClip(records, op.id, op.at, id);
    case "clip.join":
      return joinClips(records, op.id, op.next);
    case "keyframe.set":
      edit.setKeyframe(records, op.keyframe);
      return [op.keyframe.target];
    case "keyframe.remove":
      edit.removeKeyframe(records, op);
      return [op.target];
    default:
      return undefined;
  }
}

// Applies a revert or a branch operation, which need the history; a merge is applied by `apply`.
function applyHistory(records: Records, op: Operation, history: Resolver | undefined): ItemId[] {
  switch (op.op) {
    case "revert": {
      if (history === undefined) skip("unsupported", "a revert is applied by the history");
      const target = history.at(op.to);
      if (target === undefined) skip("stale", `no entry ${op.to.n} with that hash`);
      return revertTo(records, target);
    }
    case "branch.create":
    case "branch.close":
      // The history opens or closes the branch; the document doesn't change.
      if (history === undefined) skip("unsupported", `${op.op} is applied by the history`);
      if (op.op === "branch.close" && op.branch === "main") skip("structural", "main can't close");
      return [];
    default:
      return skip("unsupported", `${op.op} is applied by the history`);
  }
}

function wholeSequences(records: Records, op: Operation): ItemId[] {
  if (op.op === "revert") return [...records.sequences.keys()];
  if (op.op === "sequence.set") return [op.id];
  const role = op.op === "role.set" && op.path === "order" ? records.roles.get(op.id) : undefined;
  return role === undefined ? [] : [role.record.sequence];
}

// The item an operation is about, whose extent before and after it changed.
function subject(op: Operation, id: ItemId) {
  if (op.op === "item.add") return id;
  if ((op.op.startsWith("item.") || op.op.startsWith("clip.")) && "id" in op) return op.id;
  return undefined;
}

// The clip whose look or sound an effect or keyframe operation changes, in place.
function touched(records: Records, op: Operation) {
  let target: ItemId | undefined;
  if (op.op === "effect.add") return op.effect.clip;
  if (op.op === "effect.set" || op.op === "effect.remove") target = op.id;
  else if (op.op === "keyframe.set") target = op.keyframe.target;
  else if (op.op === "keyframe.remove") target = op.target;
  else return undefined;
  return records.effects.get(target)?.record.clip ?? target;
}

// What an operation about an item or a clip's look can redraw, as the document is now.
function spans(records: Records, about: ItemId | undefined, clip: ItemId | undefined): Span[] {
  return [
    ...(about === undefined ? [] : extents(records, about)),
    ...(clip === undefined ? [] : playing(records, clip)),
  ];
}

type Applying = Omit<Applied, "changed"> & {
  records: Records;
  history: Resolver | undefined;
  changed: Set<ItemId>;
};

function widen({ ranges }: Applying, span: Span) {
  const range = ranges.get(span.sequence);
  const from = Math.min(range?.from ?? span.from, span.from);
  const to = Math.max(range?.to ?? span.to, span.to);
  ranges.set(span.sequence, { from, to });
}

// An operation's place: its own id, its index in its batch, where its skip goes, and, for one a
// merge brought, the index of that merge in the batch applied.
type Step = { id: ItemId; index: number; skips: Skip[]; within?: number };

// Throws a skip. One a merge brought merges in turn, but doesn't revert or open or close a branch:
// those name its own branch's entries.
function run(applying: Applying, op: Operation, { id, index, within }: Step) {
  const { records, history } = applying;
  const names = op.op === "revert" || op.op === "branch.create" || op.op === "branch.close";
  if (within !== undefined && names) skip("unsupported", `${op.op} names another branch's entries`);

  if (op.op === "branch.merge" && history !== undefined) {
    merge(applying, op, { index: within ?? index, resolver: history, own: within === undefined });
    return;
  }

  const ids =
    applyRecord(records, op, id) ??
    applyItem(records, op, id) ??
    applyHistory(records, op, history);
  for (const changedId of ids) applying.changed.add(changedId);
}

function step(applying: Applying, op: Operation, place: Step) {
  const { records } = applying;
  const about = subject(op, place.id);
  const clip = touched(records, op);
  const before = spans(records, about, clip);

  try {
    run(applying, op, place);
  } catch (error) {
    if (!(error instanceof Skipped)) throw error;
    place.skips.push({ index: place.index, reason: error.reason, detail: error.message });
    return;
  }

  for (const span of [...before, ...spans(records, about, clip)]) widen(applying, span);
  for (const sequence of wholeSequences(records, op)) widen(applying, { sequence, ...EVERYTHING });
}

// Applies the batches a merge, the batch's operation `index`, brings that the document doesn't
// have yet, each operation with the id it has on its own branch.
function merge(
  applying: Applying,
  op: Merge,
  { index, resolver, own }: { index: number; resolver: Resolver; own: boolean },
) {
  const { records } = applying;
  if (own && op.branch === resolver.branch) skip("structural", "a branch can't merge itself");
  const found = resolver.merged(op);
  if (found === "missing") skip("waiting", `entries of ${op.branch} aren't here yet`);
  if (found === "stale") skip("stale", `no such entries of ${op.branch}`);

  for (const each of found) {
    if (has(records, each)) continue;
    hold(records, each);
    // Listed before the batches its own merges bring.
    const inner: Skip[] = [];
    applying.merged.push({ index, batch: each, skipped: inner });

    for (const [i, mergedOp] of each.ops.entries()) {
      step(applying, mergedOp, {
        id: itemId(each.author, each.seq, i),
        index: i,
        skips: inner,
        within: index,
      });
    }
  }
}

/**
 * Applies a batch's operations in order, skipping any that doesn't fit the document. `history`
 * resolves reverts and merges; without it they, and the other branch operations, are skipped.
 */
export function apply(records: Records, batch: Applicable, history?: Resolver): Applied {
  const applying: Applying = {
    records,
    history,
    skipped: [],
    merged: [],
    changed: new Set(),
    ranges: new Map(),
  };
  hold(records, batch);

  for (const [index, op] of batch.ops.entries()) {
    const id = itemId(batch.author, batch.seq, index);
    step(applying, op, { id, index, skips: applying.skipped });
  }

  const { skipped, merged, changed, ranges } = applying;
  return { skipped, merged, changed: [...changed], ranges };
}

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Undo (docs/architecture.md#undo-revert-and-going-back), from the documents just before a batch,
// just after it and now. A change is taken back only where it still stands as the batch left it,
// so an undo never takes back someone else's later edit.

import type { Batch } from "./batch";
import { itemId, type ItemId } from "./ids";
import { createProject, leafOf, type Document } from "./project";

type Operation = Batch["ops"][number];
type OperationOf<K extends Operation["op"]> = Extract<Operation, { op: K }>;

type Left = { index: number; reason: string };

/** `ops` take the batch back, last operation first. */
export type Undo = { ops: Operation[]; left: Left[] };

type Documents = { before: Document; after: Document; now: Document };

// A value with every object's keys in code-unit order, so records built by different paths compare
// equal when their fields are.
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== "object" || value === null) return value;
  const keys = Object.keys(value).toSorted();
  return Object.fromEntries(keys.map((key) => [key, sorted(Reflect.get(value, key))]));
}

const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

const keyframeAt = (document: Document, target: ItemId, param: string, at: number) =>
  document.keyframes(target).find((keyframe) => keyframe.param === param && keyframe.at === at);

// Whether a record is as the batch left it, and live or removed as wanted.
function stands(docs: Documents, id: string, removed: boolean) {
  const now = docs.now.record(id);
  return now !== undefined && now.removed === removed && same(now, docs.after.record(id));
}

function undoSet(
  op: OperationOf<"sequence.set" | "role.set" | "item.set" | "effect.set">,
  { before, after, now }: Documents,
): Operation[] | string {
  const was = before.record(op.id);
  // A record the batch added itself goes when its adding is undone.
  if (was === undefined) return [];
  const current = now.record(op.id);
  if (current === undefined || current.removed) return "removed since";
  const given = after.record(op.id);
  const value = leafOf(current.record, op.path);
  if (given === undefined || !same(value, leafOf(given.record, op.path))) return "changed since";
  const old = leafOf(was.record, op.path);
  if (old === undefined) return "had no value before";
  return [{ op: op.op, id: op.id, path: op.path, value: old }];
}

function undoMove(
  op: OperationOf<"item.move">,
  { before, after, now }: Documents,
): Operation[] | string {
  const was = before.item(op.id);
  if (was === undefined) return [];
  const given = after.item(op.id);
  const current = now.item(op.id);
  if (was.kind === "transition" || given?.kind === "transition" || current?.kind === "transition")
    return "not placed by an anchor";
  if (current === undefined || current.removed) return "removed since";
  if (!same(current.anchor, given?.anchor)) return "changed since";
  return [{ op: "item.move", id: op.id, anchor: was.anchor }];
}

function undoKeyframeSet(
  op: OperationOf<"keyframe.set">,
  { before, after, now }: Documents,
): Operation[] | string {
  const { target, param, at } = op.keyframe;
  const current = keyframeAt(now, target, param, at);
  if (!same(current, keyframeAt(after, target, param, at))) return "changed since";
  const old = keyframeAt(before, target, param, at);
  // A keyframe the same batch went on to remove: nothing to take back.
  if (old === undefined && current === undefined) return [];
  return [
    old === undefined
      ? { op: "keyframe.remove", target, param, at }
      : { op: "keyframe.set", keyframe: old },
  ];
}

function undoKeyframeRemove(
  op: OperationOf<"keyframe.remove">,
  { before, now }: Documents,
): Operation[] | string {
  const old = keyframeAt(before, op.target, op.param, op.at);
  // A keyframe the same batch set first: undoing that setting takes it back.
  if (old === undefined) return [];
  if (keyframeAt(now, op.target, op.param, op.at) !== undefined) return "set since";
  return [{ op: "keyframe.set", keyframe: old }];
}

// `id` is the id the operation itself took; a string is why it is left alone.
function undoOne(op: Operation, id: ItemId, docs: Documents): Operation[] | string {
  const { before, after, now } = docs;

  switch (op.op) {
    case "project.set":
      if (now.name() !== after.name()) return "renamed since";
      return [{ op: "project.set", name: before.name() }];
    case "asset.add":
      if (!stands(docs, op.asset.id, false)) return "changed since";
      return [{ op: "asset.remove", id: op.asset.id }];
    case "asset.remove": {
      const asset = before.asset(op.id);
      if (asset === undefined || !stands(docs, op.id, true)) return "changed since";
      return [{ op: "asset.add", asset }];
    }
    case "sequence.add":
      return stands(docs, id, false) ? [{ op: "sequence.remove", id }] : "changed since";
    case "role.add":
      return stands(docs, id, false) ? [{ op: "role.remove", id }] : "changed since";
    case "item.add":
      return stands(docs, id, false) ? [{ op: "item.remove", id }] : "changed since";
    case "effect.add":
      return stands(docs, id, false) ? [{ op: "effect.remove", id }] : "changed since";
    case "sequence.set":
    case "role.set":
    case "item.set":
    case "effect.set":
      return undoSet(op, docs);
    case "item.remove":
      return stands(docs, op.id, true) ? [{ op: "item.restore", id: op.id }] : "changed since";
    case "item.restore":
      return stands(docs, op.id, false) ? [{ op: "item.remove", id: op.id }] : "changed since";
    case "sequence.remove":
    case "role.remove":
    case "effect.remove":
      return "can't be restored";
    case "item.move":
      return undoMove(op, docs);
    case "clip.split":
      if (!stands(docs, op.id, false) || !stands(docs, id, false)) return "changed since";
      return [{ op: "clip.join", id: op.id, next: id }];
    case "clip.join": {
      // Split again where the first piece ended, if the joined clip is as the join left it.
      const first = before.item(op.id);
      const start = now.start(op.id);
      if (first === undefined || start === undefined || !stands(docs, op.id, false))
        return "changed since";
      return [{ op: "clip.split", id: op.id, at: start + first.duration }];
    }
    case "keyframe.set":
      return undoKeyframeSet(op, docs);
    case "keyframe.remove":
      return undoKeyframeRemove(op, docs);
    case "revert":
      return "taken back by reverting to a later entry";
    case "branch.create":
    case "branch.merge":
    case "branch.close":
      return "not undone";
    default: {
      const unknown: never = op;
      return unknown;
    }
  }
}

/**
 * `skipped` are the indexes of the operations `batch` skipped. Each operation is undone against
 * the documents as the undo's operations so far leave them, so one that a later operation of the
 * batch changed or removed is undone once that change is.
 */
export function undoBatch(
  batch: Pick<Batch, "author" | "seq" | "ops">,
  skipped: ReadonlySet<number>,
  docs: Documents,
): Undo {
  const ops: Operation[] = [];
  const left: Left[] = [];
  const now = createProject(docs.now.snapshot());
  const after = createProject(docs.after.snapshot());
  const progress = { before: docs.before, after, now };
  // The undo's own ids, which no batch has, so a split it makes in the copies takes no real id.
  const undoing = { author: batch.author, seq: Number.MAX_SAFE_INTEGER };

  for (const [index, op] of [...batch.ops.entries()].toReversed()) {
    if (skipped.has(index)) continue;
    const undo = undoOne(op, itemId(batch.author, batch.seq, index), progress);

    if (typeof undo === "string") {
      left.push({ index, reason: undo });
      continue;
    }

    ops.push(...undo);
    now.apply({ ...undoing, ops: undo });
    after.apply({ ...undoing, ops: undo });
  }

  return { ops, left };
}

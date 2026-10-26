// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Telling concurrent entries (docs/architecture.md#concurrent-edits): what each operation touches,
// and whether a batch touched what an entry its author hadn't seen touched first. An entry is
// applied either way; the mark only lets a person look at that edit again.

import type { Batch } from "./batch";
import type { Entry } from "./entry";
import type { KeyId } from "./ids";
import type { Applied } from "./project";

type Operation = Batch["ops"][number];

export type BatchRef = { author: KeyId; seq: number };

/** What one batch an entry applied touched, its own or one a merge brought, by author and seq. */
export type Touched = BatchRef & { touches: Set<string> };

// What a revert touches: every item and leaf.
const EVERYTHING = "*";

/**
 * What an operation touches: an item as a whole, written `id`, or one leaf of it, written
 * `id path`. Two leaves of one item don't clash; the whole item clashes with each of its leaves.
 */
export function touches(op: Operation): string[] {
  switch (op.op) {
    case "project.set":
      return ["project name"];
    case "asset.add":
      // An asset's id is its content's, so two authors can add the same one.
      return [op.asset.id];
    case "sequence.set":
    case "role.set":
    case "item.set":
    case "effect.set":
      return [`${op.id} ${op.path}`];
    case "keyframe.set":
      return [`${op.keyframe.target} ${op.keyframe.param}@${op.keyframe.at}`];
    case "keyframe.remove":
      return [`${op.target} ${op.param}@${op.at}`];
    case "item.move":
    case "asset.remove":
    case "sequence.remove":
    case "role.remove":
    case "item.remove":
    case "item.restore":
    case "effect.remove":
      return [op.id];
    case "clip.split":
      return [op.id];
    case "clip.join":
      return [op.id, op.next];
    case "sequence.add":
    case "role.add":
    case "item.add":
    case "effect.add":
      // What the operation adds has its own new id, which no one else can have touched.
      return [];
    case "revert":
      return [EVERYTHING];
    case "branch.create":
    case "branch.merge":
    case "branch.close":
      // Applied by the history, not to a document, so they touch nothing here.
      return [];
    default: {
      const unknown: never = op;
      return unknown;
    }
  }
}

// Whether two sets of touches clash: the same leaf, or an item and anything of it.
function clash(mine: Set<string>, theirs: Set<string>) {
  if ((mine.has(EVERYTHING) && theirs.size > 0) || (theirs.has(EVERYTHING) && mine.size > 0))
    return true;

  for (const touch of theirs) {
    if (mine.has(touch)) return true;
    const [item = "", leaf] = touch.split(" ");
    if (leaf !== undefined && mine.has(item)) return true;
  }

  for (const touch of mine) {
    const [item = "", leaf] = touch.split(" ");
    if (leaf !== undefined && theirs.has(item)) return true;
  }

  return false;
}

/** What each batch a merge brought touched. */
export const broughtTouches = (merged: Applied["merged"]): Touched[] =>
  merged.map(({ batch: { author, seq, ops }, skipped }) => {
    const left = new Set(skipped.map((skip) => skip.index));
    return { author, seq, touches: new Set(ops.filter((_, i) => !left.has(i)).flatMap(touches)) };
  });

/** What is checked for clashing: touches, against the entries after `from` and before `entry`. */
type Since = {
  from: number;
  entry: Entry;
  mine: Set<string>;
  /** Whether the authors of `mine` had seen a batch, which then doesn't clash. */
  saw: (batch: BatchRef) => boolean;
};

/**
 * Whether `mine` clashes with a batch an entry after `from` and before `entry` applied, other than
 * those `saw` says its authors had seen. `touched` is what each entry applied touched, from 1.
 */
export function clashesSince(touched: readonly Touched[][], { from, entry, mine, saw }: Since) {
  for (let n = Math.max(from, 0) + 1; n < entry.n; n += 1) {
    for (const other of touched[n - 1] ?? []) {
      if (clash(mine, other.touches) && !saw(other)) return true;
    }
  }

  return false;
}

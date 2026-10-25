// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// One branch's linear history (docs/architecture.md#linear-history): the entries its sequencer
// appends, each naming a batch, and the batches still pending. The document every peer shows is
// the entries applied in order, then the pending batches in (hlc, author) order. The entries'
// document is kept apart from the shown one, so an entry that orders batches as they are shown
// changes nothing, and one that doesn't rebuilds the shown document from the entries' alone.

import { keyIdOf, type Batch } from "./batch";
import { entries as entryFormat, type Entry } from "./entry";
import type { ItemId, KeyId } from "./ids";
import type { EntryRef } from "./document";
import {
  createProject,
  type Applied,
  type Document,
  type Range,
  type Resolver,
  type Snapshot,
} from "./project";
import { undoBatch, type Undo } from "./undo";

type Operation = Batch["ops"][number];
type BranchId = Batch["branch"];
type Merge = Extract<Operation, { op: "branch.merge" }>;

/**
 * An entry as applied, with its hash and batch: the operations it skipped, the batches its merges
 * brought, and whether its author couldn't see a change.
 */
type Entered = {
  entry: Entry;
  hash: string;
  batch: Batch;
  skipped: Applied["skipped"];
  merged: Applied["merged"];
  concurrent: boolean;
};

/**
 * The batches a merge brings, from the branch it names; the last entry of this branch their
 * authors could see, if that branch started from this one; and which batches they had seen,
 * those of the branch's document at the last entry merged. "missing" while this peer doesn't
 * have every entry it names; "stale" for entries it never will.
 */
export type Merging = (
  op: Merge,
) =>
  | { batches: readonly Batch[]; since?: number; saw: (batch: BatchRef) => boolean }
  | "missing"
  | "stale";

/** What a call changed: the records and ranges to redraw, and the entries it applied. */
export type Change = {
  changed: ItemId[];
  ranges: Map<ItemId, Range>;
  entered: Entered[];
};

type Held = { batch: Batch; hash: string };

type BatchRef = { author: KeyId; seq: number };

// What one batch an entry applied touched, its own or one a merge brought, by author and seq.
type Touched = BatchRef & { touches: Set<string> };

// The term every branch's first sequencer starts; later terms come with changing sequencer.
const FIRST_TERM = 1;

/** How many entries apart the history keeps a snapshot, so going back applies fewer than that. */
export const SNAPSHOT_EVERY = 512;

// What a revert touches: every item and leaf.
const EVERYTHING = "*";

const keyOf = (ref: { author: KeyId; seq: number }) => `${ref.author} ${ref.seq}`;

// The provisional order of pending batches: by clock, then author, by code unit, then seq, and
// last by hash, for an author who signed two batches with one seq.
function byClock(a: Held, b: Held) {
  const ka = `${a.batch.hlc} ${a.batch.author}`;
  const kb = `${b.batch.hlc} ${b.batch.author}`;
  if (ka !== kb) return ka < kb ? -1 : 1;
  if (a.batch.seq !== b.batch.seq) return a.batch.seq - b.batch.seq;
  return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
}

// What an operation touches, for telling concurrent entries: an item as a whole, written `id`,
// or one leaf of it, written `id path`. Two leaves of one item don't clash; the whole item clashes
// with each of its leaves.
function touches(op: Operation): string[] {
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

// What each batch a merge brought touched.
const broughtTouches = (merged: Applied["merged"]): Touched[] =>
  merged.map(({ batch: { author, seq, ops }, skipped }) => {
    const left = new Set(skipped.map((skip) => skip.index));
    return { author, seq, touches: new Set(ops.filter((_, i) => !left.has(i)).flatMap(touches)) };
  });

function widen(ranges: Map<ItemId, Range>, more: Map<ItemId, Range>) {
  for (const [sequence, range] of more) {
    const was = ranges.get(sequence);
    const from = Math.min(was?.from ?? range.from, range.from);
    const to = Math.max(was?.to ?? range.to, range.to);
    ranges.set(sequence, { from, to });
  }
}

const emptyChange = (): Change => ({ changed: [], ranges: new Map(), entered: [] });

function record(change: Change, applied: Pick<Applied, "changed" | "ranges">) {
  change.changed.push(...applied.changed);
  widen(change.ranges, applied.ranges);
}

/** Adds what `more` changed to `change`. */
export function combine(change: Change, more: Change) {
  record(change, more);
  change.entered.push(...more.entered);
}

const merges = (batch: Batch) => batch.ops.some(({ op }) => op === "branch.merge");

// Waits for a call that came before, whatever it did: its caller has its error.
async function settledOf(previous: Promise<unknown>) {
  try {
    await previous;
  } catch {
    // Reported to that call's caller.
  }
}

// Runs `work` once `previous` has settled, however it settled.
async function afterSettled<T>(previous: Promise<unknown>, work: () => Promise<T>) {
  await settledOf(previous);
  return work();
}

/**
 * The history of `branch`, sequenced by `sequencer`, whose document starts from `from`, or empty.
 * Batches handed to it must already be verified: signed by their author and chained to the
 * author's previous batch. Its calls run one at a time, in the order they are made, so an entry
 * that arrives twice at once is applied once. `merging` finds what a merge brings; without it,
 * every merge is stale.
 */
export function createHistory(options: {
  branch: BranchId;
  sequencer: KeyId;
  from?: Snapshot | undefined;
  merging?: Merging;
}) {
  const { branch, sequencer } = options;
  const merging = options.merging ?? (() => "stale");
  const appended: Entry[] = [];
  const hashes: string[] = [];
  // What each entry's batch, and each batch it merged, touched, for telling later entries
  // concurrent.
  const touched: Touched[][] = [];
  // Each entry's skipped operations, by index, for undoing it.
  const skips: Array<ReadonlySet<number>> = [];
  // The entry that appended each batch, by author and seq.
  const entryOf = new Map<string, number>();
  // Each author's appended batches, in the order appended.
  const byAuthor = new Map<KeyId, Batch[]>();
  // Batches by hash: an author who signs two batches with one seq has both held until an entry
  // picks one.
  const held = new Map<string, Held>();
  const pending = new Map<string, Held>();
  // Entries that arrived before their batch or before the entry ahead of them, by n.
  const early = new Map<number, Entry>();
  // Batches the sequencer has received but not yet appended, by hash, as they arrived.
  const queue: string[] = [];
  // Batches appended to this branch, by author and seq, which the same author's next batch there
  // can follow.
  const settled = new Set<string>();
  const entered = createProject(options.from);
  // The entries' document every SNAPSHOT_EVERY entries, from entry 0.
  const snapshots = new Map<number, Snapshot>([[0, entered.snapshot()]]);
  let view = createProject(entered.snapshot());
  // The pending batches as applied to the shown document, in order.
  let shown: Array<{ held: Held; applied: Applied }> = [];
  let last: Promise<unknown> = Promise.resolve();

  // Runs `work` once every call before it has finished.
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = afterSettled(last, work);
    last = run;
    return run;
  }

  function head() {
    const n = appended.length;
    return { n, hash: n === 0 ? "" : (hashes[n - 1] ?? "") };
  }

  // The batch an entry appended.
  function batchOf(n: number) {
    const each = held.get(appended[n - 1]?.batch.hash ?? "");
    if (each === undefined) throw new RangeError(`no batch for entry ${n}`);
    return each.batch;
  }

  // The entries' document at an entry, from the nearest snapshot at or before it and the entries
  // after that; undefined for an entry this history doesn't have under that hash. An entry
  // holding a revert has a snapshot of its own, so the entries replayed never hold one, and going
  // back never recurses.
  function atEntry(ref: EntryRef): Snapshot | undefined {
    if (ref.n > appended.length || ref.hash !== (ref.n === 0 ? "" : hashes[ref.n - 1]))
      return undefined;
    if (ref.n === appended.length) return entered.snapshot();
    let from = ref.n;
    while (!snapshots.has(from)) from -= 1;
    const project = createProject(snapshots.get(from));
    for (let n = from + 1; n <= ref.n; n += 1) project.apply(batchOf(n), resolver);
    return project.snapshot();
  }

  function mergedBy(op: Merge) {
    const found = merging(op);
    return typeof found === "string" ? found : found.batches;
  }

  const resolver: Resolver = { branch, at: atEntry, merged: mergedBy };

  // Whether a batch merges entries this peer doesn't have yet, so its entry has to wait.
  const waits = (batch: Batch) =>
    batch.ops.some(
      (op) => op.op === "branch.merge" && op.branch !== branch && merging(op) === "missing",
    );

  /**
   * The batches of this branch's entries a merge names, in order: every one through `through`,
   * or those named; and the last of those entries. "missing" while an entry named is ahead of the
   * last; "stale" for one under another hash.
   */
  function batchesOf(op: Merge) {
    const named = "through" in op ? [op.through] : op.entries;

    for (const ref of named) {
      if (ref.n > appended.length) return "missing";
      if (ref.hash !== (ref.n === 0 ? "" : hashes[ref.n - 1])) return "stale";
    }

    const latest = named.reduce((a, b) => (b.n > a.n ? b : a));
    const ns =
      "through" in op
        ? Array.from({ length: op.through.n }, (_, i) => i + 1)
        : [...new Set(op.entries.map(({ n }) => n))].filter((n) => n > 0).toSorted((a, b) => a - b);
    return { batches: ns.map(batchOf), latest };
  }

  /** A read-only document at an entry: going back. Throws a RangeError for an unknown entry. */
  function at(ref: EntryRef): Document {
    const snapshot = atEntry(ref);
    if (snapshot === undefined) throw new RangeError(`no entry ${ref.n} with that hash`);
    return createProject(snapshot);
  }

  // The documents just before and just after a batch of the branch, appended or pending, and the
  // operations it skipped there.
  function around(ref: BatchRef) {
    const key = keyOf(ref);
    const n = entryOf.get(key);
    let before: ReturnType<typeof createProject>;
    let batch: Batch;

    if (n === undefined) {
      const index = shown.findIndex(({ held: each }) => keyOf(each.batch) === key);
      const found = shown[index];
      if (found === undefined) throw new RangeError(`no batch ${key} on ${branch}`);
      before = createProject(entered.snapshot());
      for (const { held: each } of shown.slice(0, index)) before.apply(each.batch, resolver);
      batch = found.held.batch;
    } else {
      before = createProject(atEntry({ n: n - 1, hash: n === 1 ? "" : (hashes[n - 2] ?? "") }));
      batch = batchOf(n);
    }

    const after = createProject(before.snapshot());
    const { skipped } = after.apply(batch, resolver);
    return { batch, before, after, skipped: new Set(skipped.map(({ index }) => index)) };
  }

  /**
   * The operations that undo a batch of this branch, appended or pending, worked out against the
   * document as shown. Undoing someone else's batch is reverting it. Throws a RangeError for a
   * batch the branch doesn't have.
   */
  function undo(ref: BatchRef): Undo {
    const { batch, before, after, skipped } = around(ref);
    return undoBatch(batch, skipped, { before, after, now: view });
  }

  // An author's batches on the branch, appended or pending, newest first, with the keys of those
  // a live undo has taken back. An undo is newer than what it undoes, so it is seen first.
  function undoState(author: KeyId) {
    const pendingOwn = shown.flatMap(({ held: each, applied }) =>
      each.batch.author === author
        ? [{ batch: each.batch, skipped: new Set(applied.skipped.map(({ index }) => index)) }]
        : [],
    );
    const appendedOwn = (byAuthor.get(author) ?? []).map((batch) => ({
      batch,
      skipped: skips[(entryOf.get(keyOf(batch)) ?? 0) - 1] ?? new Set<number>(),
    }));
    // Appended in seq order, since each follows the author's previous batch on the branch, and
    // pending after them, in clock order, which is seq order for one author.
    const mine = [...appendedOwn, ...pendingOwn].toReversed();
    const undone = new Set<string>();
    const isUndo = new Set<string>();

    for (const { batch } of mine) {
      if (batch.undoes === undefined) continue;
      isUndo.add(keyOf(batch));
      if (!undone.has(keyOf(batch))) undone.add(keyOf(batch.undoes));
    }

    return { mine, undone, isUndo };
  }

  // Each author's appended batches, made on first use.
  function own(author: KeyId) {
    const batches = byAuthor.get(author) ?? [];
    byAuthor.set(author, batches);
    return batches;
  }

  /**
   * The author's latest batch on the branch that isn't an undo, isn't undone, and applied an
   * operation undo can take back: what undo takes back. A batch of only reverts and branch
   * operations is passed over; reverting to the entry before it takes it back.
   */
  function undoable(author: KeyId): BatchRef | undefined {
    const { mine, undone } = undoState(author);
    const found = mine.find(
      ({ batch, skipped }) =>
        batch.undoes === undefined &&
        !undone.has(keyOf(batch)) &&
        batch.ops.some(
          (op, i) => !skipped.has(i) && !op.op.startsWith("branch.") && op.op !== "revert",
        ),
    );
    return found === undefined ? undefined : { author, seq: found.batch.seq };
  }

  /**
   * The author's latest undo that isn't itself undone, if no edit of theirs came after it: what
   * redo takes back. A redo is an undo of an undo, so it is never redone itself.
   */
  function redoable(author: KeyId): BatchRef | undefined {
    const { mine, undone, isUndo } = undoState(author);

    for (const { batch } of mine) {
      if (undone.has(keyOf(batch))) continue;
      if (batch.undoes === undefined) return undefined;
      if (!isUndo.has(keyOf(batch.undoes))) return { author, seq: batch.seq };
    }

    return undefined;
  }

  // Shows the pending batches again from the entries' document, in order, recording what both
  // the old and the new showing touched.
  function reshow(change: Change) {
    for (const { applied } of shown) record(change, applied);
    view = createProject(entered.snapshot());
    shown = [...pending.values()].toSorted(byClock).map((each) => {
      const applied = view.apply(each.batch, resolver);
      record(change, applied);
      return { held: each, applied };
    });
  }

  // Whether `mine` clashes with a batch an entry after `from` and before `entry` applied, other
  // than those `saw` says its authors had seen.
  function clashesSince(
    from: number,
    entry: Entry,
    mine: Set<string>,
    saw: (b: BatchRef) => boolean,
  ) {
    for (let n = Math.max(from, 0) + 1; n < entry.n; n += 1) {
      for (const other of touched[n - 1] ?? []) {
        if (clash(mine, other.touches) && !saw(other)) return true;
      }
    }

    return false;
  }

  // Whether a merge of a batch is concurrent: what it brought clashes with a change on this branch,
  // since the branch it names started here or else since the batch's base, that the merged
  // batches' authors hadn't seen.
  function mergeClashes(entry: Entry, batch: Batch, applied: Applied) {
    return batch.ops.some((op, index) => {
      if (op.op !== "branch.merge") return false;
      const found = merging(op);
      if (typeof found === "string") return false;
      const brought = new Set<string>();

      for (const each of broughtTouches(applied.merged.filter((one) => one.index === index))) {
        for (const touch of each.touches) brought.add(touch);
      }

      return (
        brought.size > 0 && clashesSince(found.since ?? batch.base.n, entry, brought, found.saw)
      );
    });
  }

  // Whether an entry can be the next: chained to the last, naming a batch whose author's seq on
  // the branch isn't appended yet, and that is the batch held under its hash if one is.
  function follows(entry: Entry) {
    const each = held.get(entry.batch.hash);
    return (
      entry.n === appended.length + 1 &&
      entry.prev === head().hash &&
      !settled.has(keyOf(entry.batch)) &&
      (each === undefined || keyOf(each.batch) === keyOf(entry.batch))
    );
  }

  // Applies the next entry, whose batch is held, to the entries' document.
  function enter(entry: Entry, hash: string, change: Change) {
    const each = held.get(entry.batch.hash);
    if (each === undefined || !follows(entry))
      throw new RangeError(`entry ${entry.n} can't follow`);
    const key = keyOf(each.batch);
    // A revert to the last entry means the document before this batch, not the entries'
    // document part way through applying it.
    const reverts = each.batch.ops.some(({ op }) => op === "revert");
    const prior = reverts ? entered.snapshot() : undefined;
    const ahead = head();
    const applied = entered.apply(each.batch, {
      ...resolver,
      at: (ref) =>
        prior !== undefined && ref.n === ahead.n && ref.hash === ahead.hash ? prior : atEntry(ref),
    });
    const skipped = new Set(applied.skipped.map((skip) => skip.index));
    const mine = new Set(each.batch.ops.filter((_, i) => !skipped.has(i)).flatMap(touches));
    const { author } = each.batch;
    const isConcurrent =
      clashesSince(each.batch.base.n, entry, mine, (other) => other.author === author) ||
      mergeClashes(entry, each.batch, applied);
    appended.push(entry);
    hashes.push(hash);
    touched.push([
      { author, seq: each.batch.seq, touches: mine },
      ...broughtTouches(applied.merged),
    ]);
    skips.push(skipped);
    entryOf.set(key, entry.n);
    own(each.batch.author).push(each.batch);
    if (entry.n % SNAPSHOT_EVERY === 0 || reverts) snapshots.set(entry.n, entered.snapshot());
    settled.add(key);
    change.entered.push({
      entry,
      hash,
      batch: each.batch,
      skipped: applied.skipped,
      merged: applied.merged,
      concurrent: isConcurrent,
    });
    // Another batch the author signed with the same seq can never be appended now.
    let others = false;

    for (const [other, { batch }] of pending) {
      if (keyOf(batch) !== key) continue;
      pending.delete(other);
      if (other !== each.hash) held.delete(other);
      others ||= other !== each.hash;
    }

    // The entry orders its batch as the shown document had it first: nothing shown changes. A
    // revert or a merge is the exception, since what it brings depends on the entries this peer
    // had when it showed the batch.
    if (shown[0]?.held === each && !others && !reverts && !merges(each.batch)) {
      shown.shift();
      return;
    }

    record(change, applied);
    reshow(change);
  }

  // Applies every early entry that is next and whose batch is held. One that turns out not to
  // follow is dropped; a valid entry with its number can still come.
  async function drain(change: Change) {
    for (let next = early.get(appended.length + 1); next !== undefined;) {
      if (!follows(next)) {
        early.delete(next.n);
        return;
      }

      const each = held.get(next.batch.hash);
      if (each === undefined || waits(each.batch)) return;
      early.delete(next.n);
      const hash = await entryFormat.hash(next);
      enter(next, hash, change);
      next = early.get(appended.length + 1);
    }
  }

  async function pendNow(batch: Batch, hash: string): Promise<Change> {
    if (batch.branch !== branch) throw new RangeError(`a batch for ${batch.branch}`);
    const change = emptyChange();
    if (held.has(hash) || settled.has(keyOf(batch))) return change;
    const each = { batch, hash };
    held.set(hash, each);
    pending.set(hash, each);
    queue.push(hash);
    const end = shown.at(-1)?.held;

    if (end === undefined || byClock(end, each) < 0) {
      const applied = view.apply(batch, resolver);
      shown.push({ held: each, applied });
      record(change, applied);
    } else {
      reshow(change);
    }

    await drain(change);
    return change;
  }

  async function appendNow(entry: Entry): Promise<Change> {
    if (entry.branch !== branch) throw new RangeError(`an entry of ${entry.branch}`);
    if (entry.term !== FIRST_TERM) throw new RangeError(`an entry of term ${entry.term}`);
    const valid = await entryFormat.verify(entry, sequencer);
    if (!valid) throw new RangeError("an entry not signed by the sequencer");
    const change = emptyChange();

    if (entry.n <= appended.length) {
      const hash = await entryFormat.hash(entry);
      if (hash !== hashes[entry.n - 1]) throw new RangeError(`another entry ${entry.n}`);
      return change;
    }

    if (entry.n === appended.length + 1 && !follows(entry))
      throw new RangeError(`entry ${entry.n} doesn't follow`);
    early.set(entry.n, entry);
    await drain(change);
    return change;
  }

  // Whether a batch can be appended: its seq isn't yet, its author's previous batch on the branch
  // is, and this peer has every entry it merges.
  const ready = ({ batch }: Held) =>
    !settled.has(keyOf(batch)) &&
    (batch.branchPrev === 0 ||
      settled.has(keyOf({ author: batch.author, seq: batch.branchPrev }))) &&
    !waits(batch);

  async function sequenceNow(peer: CryptoKeyPair) {
    const self = await keyIdOf(peer.publicKey);
    if (self !== sequencer) throw new RangeError("only the sequencer appends");
    const change = emptyChange();
    const made: Entry[] = [];
    // Entries it signed that wait for their batches, as after opening a project with a log that
    // didn't read, hold numbers it must not sign again.
    if (early.size > 0) return { entries: made, change };
    const waiting = queue
      .splice(0)
      .flatMap((hash) => {
        const each = held.get(hash);
        return each === undefined || settled.has(keyOf(each.batch)) ? [] : [each];
      })
      .toSorted(byClock);

    // Always the first ready batch in order, so one that appending unblocks keeps its place.
    for (let i = waiting.findIndex(ready); i !== -1; i = waiting.findIndex(ready)) {
      const [each] = waiting.splice(i, 1);
      if (each === undefined) break;
      const { author, seq } = each.batch;
      const ahead = head();
      const entry = await entryFormat.sign(peer.privateKey, {
        branch,
        n: ahead.n + 1,
        term: FIRST_TERM,
        prev: ahead.hash,
        batch: { author, seq, hash: each.hash },
      });
      const hash = await entryFormat.hash(entry);
      enter(entry, hash, change);
      made.push(entry);
    }

    queue.unshift(...waiting.map((each) => each.hash));
    return { entries: made, change };
  }

  // Applies the entries that were waiting for another branch's entries, and shows pending merges
  // again with what this peer now has.
  async function retryNow() {
    const change = emptyChange();
    await drain(change);
    if (shown.some(({ held: each }) => merges(each.batch))) reshow(change);
    return change;
  }

  return {
    /** Takes a verified batch for this branch, showing it as pending until an entry appends it. */
    pend: (batch: Batch, hash: string) => serial(() => pendNow(batch, hash)),
    /**
     * Takes an entry from the sequencer. One for a batch not yet held, or ahead of the next
     * entry, waits until both are here. Throws a RangeError for an entry that isn't this
     * branch's sequencer's, that is next and doesn't follow the last, or that differs from the
     * entry already appended with its number.
     */
    append: (entry: Entry) => serial(() => appendNow(entry)),
    /**
     * As the sequencer, appends every received batch that can be: in (hlc, author, seq) order,
     * each once its author's previous batch on the branch is appended, and none while an entry
     * ahead of the last waits. Returns the entries to publish.
     */
    sequence: (peer: CryptoKeyPair) => serial(() => sequenceNow(peer)),
    /**
     * Tries again what waits for another branch: an entry whose batch merges entries this peer
     * didn't have, and the pending merges shown. Called when another branch appends entries.
     */
    retry: () => serial(retryNow),
    /** The batches of the entries a merge names, and the last of them, as `Merging` needs. */
    batches: batchesOf,
    /** The last entry, as a batch's `base` names it. */
    head,
    at,
    undo,
    undoable,
    redoable,
    /** The entries, 1 to n. */
    entries: (): readonly Entry[] => appended,
    /** The pending batches, in the order they are shown. */
    pending: () => shown.map(({ held: each }) => each.batch),
    /** The document as shown: the entries, then the pending batches. */
    document: (): Document => view,
  };
}

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// One branch's linear history (docs/architecture.md#linear-history): every peer shows the entries
// in order, then the pending batches in (hlc, author) order. The entries' document is kept apart,
// so an entry ordering batches as shown changes nothing; one that doesn't rebuilds the shown one.

import { keyIdOf, type Batch } from "./batch";
import { broughtTouches, clashesSince, touches, type BatchRef, type Touched } from "./concurrent";
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
import { createSerial, queued } from "./serial";
import { undoBatch, type Undo } from "./undo";

type Operation = Batch["ops"][number];
type BranchId = Batch["branch"];
type Merge = Extract<Operation, { op: "branch.merge" }>;
type Project = ReturnType<typeof createProject>;

/** `concurrent` is whether its author couldn't see a change. */
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

type State = {
  branch: BranchId;
  sequencer: KeyId;
  merging: Merging;
  appended: Entry[];
  hashes: string[];
  // What each entry's batch, and each batch it merged, touched, for telling later entries
  // concurrent.
  touched: Touched[][];
  // Each entry's skipped operations, by index, for undoing it.
  skips: Array<ReadonlySet<number>>;
  entryOf: Map<string, number>;
  byAuthor: Map<KeyId, Batch[]>;
  // Batches by hash: an author who signs two batches with one seq has both held until an entry
  // picks one.
  held: Map<string, Held>;
  pending: Map<string, Held>;
  // Entries that arrived before their batch or before the entry ahead of them, by n.
  early: Map<number, Entry>;
  // Batches the sequencer has received but not yet appended, by hash, as they arrived.
  queue: string[];
  // Batches appended to this branch, by author and seq, which the same author's next batch there
  // can follow.
  settled: Set<string>;
  entered: Project;
  // The entries' document every SNAPSHOT_EVERY entries, from entry 0.
  snapshots: Map<number, Snapshot>;
  view: Project;
  shown: Array<{ held: Held; applied: Applied }>;
  resolver: Resolver;
};

// The term every branch's first sequencer starts; later terms come with changing sequencer.
const FIRST_TERM = 1;

/** How many entries apart the history keeps a snapshot, so going back applies fewer than that. */
export const SNAPSHOT_EVERY = 512;

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

const skippedOf = (applied: Applied) => new Set(applied.skipped.map(({ index }) => index));

function head(state: State) {
  const n = state.appended.length;
  return { n, hash: n === 0 ? "" : (state.hashes[n - 1] ?? "") };
}

function batchOf(state: State, n: number) {
  const each = state.held.get(state.appended[n - 1]?.batch.hash ?? "");
  if (each === undefined) throw new RangeError(`no batch for entry ${n}`);
  return each.batch;
}

// Whether this history has an entry under the hash `ref` names.
const named = (state: State, ref: EntryRef) =>
  ref.hash === (ref.n === 0 ? "" : state.hashes[ref.n - 1]);

// The entries' document at an entry, from the nearest snapshot at or before it; undefined for an
// entry not here under that hash. An entry holding a revert has a snapshot of its own, so the
// entries replayed never hold one, and going back never recurses.
function atEntry(state: State, ref: EntryRef): Snapshot | undefined {
  if (ref.n > state.appended.length || !named(state, ref)) return undefined;
  if (ref.n === state.appended.length) return state.entered.snapshot();
  let from = ref.n;
  while (!state.snapshots.has(from)) from -= 1;
  const project = createProject(state.snapshots.get(from));
  for (let n = from + 1; n <= ref.n; n += 1) project.apply(batchOf(state, n), state.resolver);
  return project.snapshot();
}

// Whether a batch merges entries this peer doesn't have yet, so its entry has to wait.
const waits = (state: State, batch: Batch) =>
  batch.ops.some(
    (op) =>
      op.op === "branch.merge" && op.branch !== state.branch && state.merging(op) === "missing",
  );

/**
 * The batches of this branch's entries a merge names, in order: every one through `through`, or
 * those named; and the last of those entries. "missing" while an entry named is ahead of the last;
 * "stale" for one under another hash.
 */
function batchesOf(state: State, op: Merge) {
  const refs = "through" in op ? [op.through] : op.entries;

  for (const ref of refs) {
    if (ref.n > state.appended.length) return "missing";
    if (!named(state, ref)) return "stale";
  }

  const latest = refs.reduce((a, b) => (b.n > a.n ? b : a));
  const ns =
    "through" in op
      ? Array.from({ length: op.through.n }, (_, i) => i + 1)
      : [...new Set(op.entries.map(({ n }) => n))].filter((n) => n > 0).toSorted((a, b) => a - b);
  return { batches: ns.map((n) => batchOf(state, n)), latest };
}

// The documents just before and just after a batch of the branch, appended or pending, and the
// operations it skipped there.
function around(state: State, ref: BatchRef) {
  const key = keyOf(ref);
  const n = state.entryOf.get(key);
  let before: Project;
  let batch: Batch;

  if (n === undefined) {
    const index = state.shown.findIndex(({ held: each }) => keyOf(each.batch) === key);
    const found = state.shown[index];
    if (found === undefined) throw new RangeError(`no batch ${key} on ${state.branch}`);
    before = createProject(state.entered.snapshot());
    for (const { held: each } of state.shown.slice(0, index))
      before.apply(each.batch, state.resolver);
    batch = found.held.batch;
  } else {
    const prior = { n: n - 1, hash: n === 1 ? "" : (state.hashes[n - 2] ?? "") };
    before = createProject(atEntry(state, prior));
    batch = batchOf(state, n);
  }

  const after = createProject(before.snapshot());
  const applied = after.apply(batch, state.resolver);
  return { batch, before, after, skipped: skippedOf(applied) };
}

// An author's batches on the branch, appended or pending, newest first, with the keys of those a
// live undo has taken back. An undo is newer than what it undoes, so it is seen first.
function undoState(state: State, author: KeyId) {
  const pendingOwn = state.shown.flatMap(({ held: each, applied }) =>
    each.batch.author === author ? [{ batch: each.batch, skipped: skippedOf(applied) }] : [],
  );
  const appendedOwn = (state.byAuthor.get(author) ?? []).map((batch) => ({
    batch,
    skipped: state.skips[(state.entryOf.get(keyOf(batch)) ?? 0) - 1] ?? new Set<number>(),
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

// A batch of only reverts and branch operations is passed over: reverting to before it undoes it.
function undoable(state: State, author: KeyId): BatchRef | undefined {
  const { mine, undone } = undoState(state, author);
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

// None once the author edits after their undo; a redo is an undo of an undo, so never redone.
function redoable(state: State, author: KeyId): BatchRef | undefined {
  const { mine, undone, isUndo } = undoState(state, author);

  for (const { batch } of mine) {
    if (undone.has(keyOf(batch))) continue;
    if (batch.undoes === undefined) return undefined;
    if (!isUndo.has(keyOf(batch.undoes))) return { author, seq: batch.seq };
  }

  return undefined;
}

// Shows the pending batches again from the entries' document, in order, recording what both the
// old and the new showing touched.
function reshow(state: State, change: Change) {
  for (const { applied } of state.shown) record(change, applied);
  const view = createProject(state.entered.snapshot());
  state.view = view;
  state.shown = [...state.pending.values()].toSorted(byClock).map((each) => {
    const applied = view.apply(each.batch, state.resolver);
    record(change, applied);
    return { held: each, applied };
  });
}

// Whether a merge of a batch is concurrent: what it brought clashes with a change on this branch,
// since the branch it names started here or else since the batch's base, that the merged batches'
// authors hadn't seen.
function mergeClashes(state: State, entry: Entry, batch: Batch, applied: Applied) {
  return batch.ops.some((op, index) => {
    if (op.op !== "branch.merge") return false;
    const found = state.merging(op);
    if (typeof found === "string") return false;
    const brought = new Set<string>();

    for (const each of broughtTouches(applied.merged.filter((one) => one.index === index))) {
      for (const touch of each.touches) brought.add(touch);
    }

    const from = found.since ?? batch.base.n;
    const since = { from, entry, mine: brought, saw: found.saw };
    return brought.size > 0 && clashesSince(state.touched, since);
  });
}

// Whether an entry can be the next: chained to the last, naming a batch whose author's seq on the
// branch isn't appended yet, and that is the batch held under its hash if one is.
function follows(state: State, entry: Entry) {
  const each = state.held.get(entry.batch.hash);
  return (
    entry.n === state.appended.length + 1 &&
    entry.prev === head(state).hash &&
    !state.settled.has(keyOf(entry.batch)) &&
    (each === undefined || keyOf(each.batch) === keyOf(entry.batch))
  );
}

// Applies a batch to the entries' document as the next entry's. A revert to the last entry means
// the document before this batch, not the entries' document part way through applying it.
function applyNext(state: State, batch: Batch) {
  const reverts = batch.ops.some(({ op }) => op === "revert");
  const prior = reverts ? state.entered.snapshot() : undefined;
  const ahead = head(state);
  const applied = state.entered.apply(batch, {
    ...state.resolver,
    at: (ref) =>
      prior !== undefined && ref.n === ahead.n && ref.hash === ahead.hash
        ? prior
        : atEntry(state, ref),
  });
  return { applied, reverts };
}

type EnteredNow = { entry: Entry; hash: string; batch: Batch; applied: Applied; reverts: boolean };

function appendEntered(
  state: State,
  { entry, hash, batch, applied, reverts }: EnteredNow,
): Entered {
  const skipped = skippedOf(applied);
  const mine = new Set(batch.ops.filter((_, i) => !skipped.has(i)).flatMap(touches));
  const { author } = batch;
  const own = {
    from: batch.base.n,
    entry,
    mine,
    saw: (other: BatchRef) => other.author === author,
  };
  const concurrent = clashesSince(state.touched, own) || mergeClashes(state, entry, batch, applied);
  state.appended.push(entry);
  state.hashes.push(hash);
  state.touched.push([
    { author, seq: batch.seq, touches: mine },
    ...broughtTouches(applied.merged),
  ]);
  state.skips.push(skipped);
  state.entryOf.set(keyOf(batch), entry.n);
  const authored = state.byAuthor.get(author) ?? [];
  authored.push(batch);
  state.byAuthor.set(author, authored);
  if (entry.n % SNAPSHOT_EVERY === 0 || reverts)
    state.snapshots.set(entry.n, state.entered.snapshot());
  state.settled.add(keyOf(batch));
  const { skipped: left, merged } = applied;
  return { entry, hash, batch, skipped: left, merged, concurrent };
}

// Drops the other batches pending under the key of `each`: another batch its author signed with
// the same seq can never be appended now. Returns whether there were any.
function dropOthers(state: State, each: Held) {
  const key = keyOf(each.batch);
  let others = false;

  for (const [other, { batch }] of state.pending) {
    if (keyOf(batch) !== key) continue;
    state.pending.delete(other);
    if (other !== each.hash) state.held.delete(other);
    others ||= other !== each.hash;
  }

  return others;
}

function enter(state: State, entry: Entry, hash: string, change: Change) {
  const each = state.held.get(entry.batch.hash);
  if (each === undefined || !follows(state, entry))
    throw new RangeError(`entry ${entry.n} can't follow`);
  const { applied, reverts } = applyNext(state, each.batch);
  change.entered.push(appendEntered(state, { entry, hash, batch: each.batch, applied, reverts }));
  const others = dropOthers(state, each);

  // The entry orders its batch as the shown document had it first: nothing shown changes. A
  // revert or a merge is the exception, since what it brings depends on the entries this peer
  // had when it showed the batch.
  if (state.shown[0]?.held === each && !others && !reverts && !merges(each.batch)) {
    state.shown.shift();
    return;
  }

  record(change, applied);
  reshow(state, change);
}

// Applies every early entry that is next and whose batch is held. One that turns out not to follow
// is dropped; a valid entry with its number can still come.
async function drain(state: State, change: Change) {
  for (let next = state.early.get(state.appended.length + 1); next !== undefined;) {
    if (!follows(state, next)) {
      state.early.delete(next.n);
      return;
    }

    const each = state.held.get(next.batch.hash);
    if (each === undefined || waits(state, each.batch)) return;
    state.early.delete(next.n);
    const hash = await entryFormat.hash(next);
    enter(state, next, hash, change);
    next = state.early.get(state.appended.length + 1);
  }
}

async function pendNow(state: State, batch: Batch, hash: string): Promise<Change> {
  if (batch.branch !== state.branch) throw new RangeError(`a batch for ${batch.branch}`);
  const change = emptyChange();
  if (state.held.has(hash) || state.settled.has(keyOf(batch))) return change;
  const each = { batch, hash };
  state.held.set(hash, each);
  state.pending.set(hash, each);
  state.queue.push(hash);
  const end = state.shown.at(-1)?.held;

  if (end === undefined || byClock(end, each) < 0) {
    const applied = state.view.apply(batch, state.resolver);
    state.shown.push({ held: each, applied });
    record(change, applied);
  } else {
    reshow(state, change);
  }

  await drain(state, change);
  return change;
}

async function appendNow(state: State, entry: Entry): Promise<Change> {
  if (entry.branch !== state.branch) throw new RangeError(`an entry of ${entry.branch}`);
  if (entry.term !== FIRST_TERM) throw new RangeError(`an entry of term ${entry.term}`);
  const valid = await entryFormat.verify(entry, state.sequencer);
  if (!valid) throw new RangeError("an entry not signed by the sequencer");
  const change = emptyChange();

  if (entry.n <= state.appended.length) {
    const hash = await entryFormat.hash(entry);
    if (hash !== state.hashes[entry.n - 1]) throw new RangeError(`another entry ${entry.n}`);
    return change;
  }

  if (entry.n === state.appended.length + 1 && !follows(state, entry))
    throw new RangeError(`entry ${entry.n} doesn't follow`);
  state.early.set(entry.n, entry);
  await drain(state, change);
  return change;
}

// Whether a batch can be appended: its seq isn't yet, its author's previous batch on the branch
// is, and this peer has every entry it merges.
const ready = (state: State, { batch }: Held) =>
  !state.settled.has(keyOf(batch)) &&
  (batch.branchPrev === 0 ||
    state.settled.has(keyOf({ author: batch.author, seq: batch.branchPrev }))) &&
  !waits(state, batch);

function waiting(state: State) {
  return state.queue
    .splice(0)
    .flatMap((hash) => {
      const each = state.held.get(hash);
      return each === undefined || state.settled.has(keyOf(each.batch)) ? [] : [each];
    })
    .toSorted(byClock);
}

async function sequenceNow(state: State, peer: CryptoKeyPair) {
  const self = await keyIdOf(peer.publicKey);
  if (self !== state.sequencer) throw new RangeError("only the sequencer appends");
  const change = emptyChange();
  const made: Entry[] = [];
  // Entries it signed that wait for their batches, as after opening a project with a log that
  // didn't read, hold numbers it must not sign again.
  if (state.early.size > 0) return { entries: made, change };
  const queue = waiting(state);
  const isReady = (each: Held) => ready(state, each);

  // Always the first ready batch in order, so one that appending unblocks keeps its place.
  for (let i = queue.findIndex(isReady); i !== -1; i = queue.findIndex(isReady)) {
    const [each] = queue.splice(i, 1);
    if (each === undefined) break;
    const { author, seq } = each.batch;
    const ahead = head(state);
    const entry = await entryFormat.sign(peer.privateKey, {
      branch: state.branch,
      n: ahead.n + 1,
      term: FIRST_TERM,
      prev: ahead.hash,
      batch: { author, seq, hash: each.hash },
    });
    const hash = await entryFormat.hash(entry);
    enter(state, entry, hash, change);
    made.push(entry);
  }

  state.queue.unshift(...queue.map((each) => each.hash));
  return { entries: made, change };
}

// Applies the entries that were waiting for another branch's entries, and shows pending merges
// again with what this peer now has.
async function retryNow(state: State) {
  const change = emptyChange();
  await drain(state, change);
  if (state.shown.some(({ held: each }) => merges(each.batch))) reshow(state, change);
  return change;
}

type Options = {
  branch: BranchId;
  sequencer: KeyId;
  from?: Snapshot | undefined;
  merging?: Merging;
};

function createState(options: Options): State {
  const { branch, sequencer } = options;
  const merging = options.merging ?? (() => "stale");
  const entered = createProject(options.from);

  const mergedBy = (op: Merge) => {
    const found = merging(op);
    return typeof found === "string" ? found : found.batches;
  };

  const state: State = {
    branch,
    sequencer,
    merging,
    appended: [],
    hashes: [],
    touched: [],
    skips: [],
    entryOf: new Map(),
    byAuthor: new Map(),
    held: new Map(),
    pending: new Map(),
    early: new Map(),
    queue: [],
    settled: new Set(),
    entered,
    snapshots: new Map([[0, entered.snapshot()]]),
    view: createProject(entered.snapshot()),
    shown: [],
    resolver: { branch, at: (ref) => atEntry(state, ref), merged: mergedBy },
  };
  return state;
}

/**
 * The history of `branch`, sequenced by `sequencer`, whose document starts from `from`, or empty.
 * Batches handed to it must already be verified: signed by their author and chained to the
 * author's previous batch. Its calls run one at a time, in the order they are made, so an entry
 * that arrives twice at once is applied once. `merging` finds what a merge brings; without it,
 * every merge is stale.
 */
export function createHistory(options: Options) {
  const state = createState(options);
  const serial = createSerial();

  return {
    /** Takes a verified batch for this branch, showing it as pending until an entry appends it. */
    pend: queued(serial, state, pendNow),
    /**
     * Takes an entry from the sequencer. One for a batch not yet held, or ahead of the next
     * entry, waits until both are here. Throws a RangeError for an entry that isn't this
     * branch's sequencer's, that is next and doesn't follow the last, or that differs from the
     * entry already appended with its number.
     */
    append: queued(serial, state, appendNow),
    /**
     * As the sequencer, appends every received batch that can be: in (hlc, author, seq) order,
     * each once its author's previous batch on the branch is appended, and none while an entry
     * ahead of the last waits. Returns the entries to publish.
     */
    sequence: queued(serial, state, sequenceNow),
    /**
     * Tries again what waits for another branch: an entry whose batch merges entries this peer
     * didn't have, and the pending merges shown. Called when another branch appends entries.
     */
    retry: queued(serial, state, retryNow),
    /** The batches of the entries a merge names, and the last of them, as `Merging` needs. */
    batches: (op: Merge) => batchesOf(state, op),
    /** The last entry, as a batch's `base` names it. */
    head: () => head(state),
    /** A read-only document at an entry: going back. Throws a RangeError for an unknown entry. */
    at: (ref: EntryRef): Document => {
      const snapshot = atEntry(state, ref);
      if (snapshot === undefined) throw new RangeError(`no entry ${ref.n} with that hash`);
      return createProject(snapshot);
    },
    /**
     * The operations that undo a batch of this branch, appended or pending, worked out against
     * the document as shown. Undoing someone else's batch is reverting it. Throws a RangeError
     * for a batch the branch doesn't have.
     */
    undo: (ref: BatchRef): Undo => {
      const { batch, before, after, skipped } = around(state, ref);
      return undoBatch(batch, skipped, { before, after, now: state.view });
    },
    /**
     * The author's latest batch on the branch that isn't an undo, isn't undone, and applied an
     * operation undo can take back: what undo takes back. A batch of only reverts and branch
     * operations is passed over; reverting to the entry before it takes it back.
     */
    undoable: (author: KeyId) => undoable(state, author),
    /**
     * The author's latest undo that isn't itself undone, if no edit of theirs came after it: what
     * redo takes back. A redo is an undo of an undo, so it is never redone itself.
     */
    redoable: (author: KeyId) => redoable(state, author),
    /** The entries, 1 to n. */
    entries: (): readonly Entry[] => state.appended,
    /** The pending batches, in the order they are shown. */
    pending: () => state.shown.map(({ held: each }) => each.batch),
    /** The document as shown: the entries, then the pending batches. */
    document: (): Document => state.view,
  };
}

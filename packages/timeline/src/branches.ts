// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A project's branches (docs/architecture.md#branches): main, and one per `branch.create` entry,
// each sequenced by its creator. Batches and entries for a branch whose creating entry isn't
// applied here yet wait for it, as do entries merging entries this peer doesn't have yet.

import { keyIdOf, type Batch } from "./batch";
import type { EntryRef } from "./document";
import type { Entry } from "./entry";
import { combine, createHistory, type Change, type Merging } from "./history";
import { itemId, type KeyId } from "./ids";
import type { Snapshot } from "./project";
import { createSerial, queued } from "./serial";

type BranchId = Batch["branch"];
type History = ReturnType<typeof createHistory>;

// What a caller reads of a branch's history: everything but handing it batches and entries, which
// go through the branches, so that what they open and close is followed.
const readOnly = (history: History) => ({
  head: history.head,
  at: history.at,
  undo: history.undo,
  undoable: history.undoable,
  redoable: history.redoable,
  entries: history.entries,
  pending: history.pending,
  document: history.document,
});

const none = (): Changes => new Map();

/** `from` is undefined for main. */
export type Branch = {
  id: BranchId;
  name: string;
  from?: { branch: BranchId; entry: EntryRef };
  sequencer: KeyId;
  closed: boolean;
};

export type Changes = Map<BranchId, Change>;

type State = {
  branches: Map<BranchId, { branch: Branch; history: History }>;
  // Every branch a `branch.close` entry closed, including one not created here yet.
  closed: Set<BranchId>;
  // Batches and entries for branches not created here yet, in the order they arrived.
  waitingBatches: Array<{ batch: Batch; hash: string }>;
  waitingEntries: Entry[];
};

function gather(changes: Changes, branch: BranchId, change: Change) {
  const into = changes.get(branch);
  if (into === undefined) changes.set(branch, change);
  else combine(into, change);
}

// What a merge into `target` brings: entries of a branch, once this peer has them all. A merge of
// the target itself is only ever one a merge brought, and brings nothing new.
const mergingInto =
  (state: State, target: BranchId): Merging =>
  (op) => {
    const source = state.branches.get(op.branch);
    if (source === undefined) return "missing";
    const found = source.history.batches(op);
    if (typeof found === "string") return found;
    let seen: ((batch: { author: KeyId; seq: number }) => boolean) | undefined;

    // Worked out only when an entry is checked for concurrency.
    const saw = (batch: { author: KeyId; seq: number }) => {
      seen ??= source.history.at(found.latest).has;
      return seen(batch);
    };

    const { from } = source.branch;
    const since = from?.branch === target ? { since: from.entry.n } : {};
    return { batches: found.batches, saw, ...since };
  };

function open(state: State, branch: Omit<Branch, "closed">, from?: Snapshot) {
  const { id, sequencer } = branch;
  const merging = mergingInto(state, id);
  const history = createHistory({ branch: id, sequencer, from, merging });
  state.branches.set(id, { branch: { ...branch, closed: state.closed.has(id) }, history });
}

// Opens the branches an entry of `branch` creates and closes those it closes.
function follow(state: State, branch: BranchId, entered: Change["entered"][number]) {
  const { entry, hash, batch, skipped } = entered;
  const left = new Set(skipped.map(({ index }) => index));
  const history = state.branches.get(branch)?.history;
  if (history === undefined) throw new RangeError(`no branch ${branch}`);

  for (const [index, op] of batch.ops.entries()) {
    if (left.has(index)) continue;

    if (op.op === "branch.close") {
      state.closed.add(op.branch);
      const found = state.branches.get(op.branch);
      if (found !== undefined) found.branch.closed = true;
    }

    if (op.op !== "branch.create") continue;
    // The document at the entry, the whole batch applied.
    const at = { n: entry.n, hash };
    const id = itemId(batch.author, batch.seq, index);
    open(
      state,
      { id, name: op.name, from: { branch, entry: at }, sequencer: batch.author },
      history.at(at).snapshot(),
    );
  }
}

// Hands the branches now here what waited for them, and tries every branch again; returns what
// each call changed.
async function deliverWaiting(state: State) {
  const changes: Array<{ branch: BranchId; change: Change }> = [];
  const batches = state.waitingBatches;
  const entries = state.waitingEntries;
  state.waitingBatches = [];
  state.waitingEntries = [];

  for (const { batch, hash } of batches) {
    const found = state.branches.get(batch.branch);

    if (found === undefined) {
      state.waitingBatches.push({ batch, hash });
      continue;
    }

    const pended = await found.history.pend(batch, hash);
    changes.push({ branch: batch.branch, change: pended });
  }

  for (const entry of entries) {
    const appended = await appendWaiting(state, entry);
    if (appended !== undefined) changes.push({ branch: entry.branch, change: appended });
  }

  for (const [id, { history }] of state.branches) {
    const retried = await history.retry();
    changes.push({ branch: id, change: retried });
  }

  return changes;
}

// Follows what each change entered, handing the branches it opens what waited for them and
// trying every branch again, until nothing more is entered.
async function settle(state: State, changes: Changes, first: { branch: BranchId; change: Change }) {
  const queue = [first];

  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    gather(changes, next.branch, next.change);
    if (next.change.entered.length === 0) continue;
    for (const entered of next.change.entered) follow(state, next.branch, entered);
    const more = await deliverWaiting(state);
    queue.push(...more);
  }

  return changes;
}

// Appends an entry that waited for its branch, if the branch is here now. One the history refuses
// is dropped: its caller is long gone, and a valid entry with its number can still come.
async function appendWaiting(state: State, entry: Entry) {
  const found = state.branches.get(entry.branch);

  if (found === undefined) {
    state.waitingEntries.push(entry);
    return undefined;
  }

  try {
    const appended = await found.history.append(entry);
    return appended;
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

async function pendNow(state: State, batch: Batch, hash: string) {
  const found = state.branches.get(batch.branch);

  if (found === undefined) {
    state.waitingBatches.push({ batch, hash });
    return none();
  }

  const change = await found.history.pend(batch, hash);
  return settle(state, none(), { branch: batch.branch, change });
}

async function appendNow(state: State, entry: Entry) {
  const found = state.branches.get(entry.branch);

  if (found === undefined) {
    state.waitingEntries.push(entry);
    return none();
  }

  const change = await found.history.append(entry);
  return settle(state, none(), { branch: entry.branch, change });
}

async function sequenceNow(state: State, peer: CryptoKeyPair) {
  const self = await keyIdOf(peer.publicKey);
  const changes = none();
  const made: Entry[] = [];

  // A branch this sequencing opens is in the map by the time the loop reaches it.
  for (const [id, { branch, history }] of state.branches) {
    if (branch.sequencer !== self || state.closed.has(id)) continue;
    const { entries, change } = await history.sequence(peer);
    made.push(...entries);
    await settle(state, changes, { branch: id, change });
  }

  return { entries: made, changes };
}

/**
 * A project's branches, with main sequenced by `sequencer` from `from`, or empty. Batches and
 * entries handed to it must already be verified, as `createHistory` asks. Its calls run one at a
 * time, in the order they are made.
 */
export function createBranches(options: { sequencer: KeyId; from?: Snapshot }) {
  const state: State = {
    branches: new Map(),
    closed: new Set(),
    waitingBatches: [],
    waitingEntries: [],
  };
  const serial = createSerial();
  open(state, { id: "main", name: "main", sequencer: options.sequencer }, options.from);

  return {
    /** Takes a verified batch, for its branch's history, or to wait until the branch is created. */
    pend: queued(serial, state, pendNow),
    /**
     * Takes an entry from a branch's sequencer, for its branch's history, or to wait until the
     * branch is created. Throws as the history's `append` does.
     */
    append: queued(serial, state, appendNow),
    /**
     * Appends what every open branch this peer sequences has received, as `createHistory`'s
     * `sequence` does. Returns the entries to publish. A batch merging entries this peer didn't
     * have waits for the next call after they arrive.
     */
    sequence: queued(serial, state, sequenceNow),
    /** The branches, main first, then in the order they were created here. */
    branches: (): ReadonlyArray<Readonly<Branch>> =>
      [...state.branches.values()].map(({ branch }) => branch),
    /** A branch's history, to read, or undefined for a branch not created here. */
    history: (id: BranchId) => {
      const found = state.branches.get(id);
      return found === undefined ? undefined : readOnly(found.history);
    },
  };
}

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A project's branches (docs/architecture.md#branches): main, and one more for each
// `branch.create` entry, each its own linear history that starts from the document at that entry
// and is sequenced by its creator. Batches and entries are handed to the branch they name; those
// for a branch whose creating entry isn't applied here yet wait for it, as do entries merging
// entries this peer doesn't have yet.

import { keyIdOf, type Batch } from "./batch";
import type { EntryRef } from "./document";
import type { Entry } from "./entry";
import { combine, createHistory, type Change, type Merging } from "./history";
import { itemId, type KeyId } from "./ids";
import type { Snapshot } from "./project";
import { createSerial } from "./serial";

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

/** A branch: its name, the entry it starts from (none for main), who sequences it, and whether closed. */
export type Branch = {
  id: BranchId;
  name: string;
  from?: { branch: BranchId; entry: EntryRef };
  sequencer: KeyId;
  closed: boolean;
};

/** What a call changed, per branch. */
export type Changes = Map<BranchId, Change>;

function gather(changes: Changes, branch: BranchId, change: Change) {
  const into = changes.get(branch);
  if (into === undefined) changes.set(branch, change);
  else combine(into, change);
}

/**
 * A project's branches, with main sequenced by `sequencer` from `from`, or empty. Batches and
 * entries handed to it must already be verified, as `createHistory` asks. Its calls run one at a
 * time, in the order they are made.
 */
export function createBranches(options: { sequencer: KeyId; from?: Snapshot }) {
  const branches = new Map<BranchId, { branch: Branch; history: History }>();
  // Every branch a `branch.close` entry closed, including one not created here yet.
  const closed = new Set<BranchId>();
  // Batches and entries for branches not created here yet, in the order they arrived.
  let waitingBatches: Array<{ batch: Batch; hash: string }> = [];
  let waitingEntries: Entry[] = [];
  const serial = createSerial();

  // What a merge into `target` brings: entries of a branch, once this peer has them all. A
  // merge of the target itself is only ever one a merge brought, and brings nothing new.
  const mergingInto =
    (target: BranchId): Merging =>
    (op) => {
      const source = branches.get(op.branch);
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

  function open(branch: Omit<Branch, "closed">, from?: Snapshot) {
    const { id, sequencer } = branch;
    const history = createHistory({ branch: id, sequencer, from, merging: mergingInto(id) });
    branches.set(id, { branch: { ...branch, closed: closed.has(id) }, history });
  }

  open({ id: "main", name: "main", sequencer: options.sequencer }, options.from);

  // Opens the branches an entry creates and closes those it closes.
  function follow(branch: BranchId, history: History, entered: Change["entered"][number]) {
    const { entry, hash, batch, skipped } = entered;
    const left = new Set(skipped.map(({ index }) => index));

    for (const [index, op] of batch.ops.entries()) {
      if (left.has(index)) continue;

      if (op.op === "branch.close") {
        closed.add(op.branch);
        const found = branches.get(op.branch);
        if (found !== undefined) found.branch.closed = true;
      }

      if (op.op !== "branch.create") continue;
      // The document at the entry, the whole batch applied.
      const at = { n: entry.n, hash };
      const id = itemId(batch.author, batch.seq, index);
      open(
        { id, name: op.name, from: { branch, entry: at }, sequencer: batch.author },
        history.at(at).snapshot(),
      );
    }
  }

  // Follows what each change entered, handing the branches it opens what waited for them and
  // trying every branch again, until nothing more is entered.
  async function settle(changes: Changes, branch: BranchId, change: Change) {
    const queue = [{ branch, change }];

    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      gather(changes, next.branch, next.change);
      if (next.change.entered.length === 0) continue;
      const own = branches.get(next.branch)?.history;
      if (own === undefined) throw new RangeError(`no branch ${next.branch}`);
      for (const entered of next.change.entered) follow(next.branch, own, entered);
      const batches = waitingBatches;
      const entries = waitingEntries;
      waitingBatches = [];
      waitingEntries = [];

      for (const { batch, hash } of batches) {
        const found = branches.get(batch.branch);

        if (found === undefined) {
          waitingBatches.push({ batch, hash });
          continue;
        }

        const pended = await found.history.pend(batch, hash);
        queue.push({ branch: batch.branch, change: pended });
      }

      for (const entry of entries) {
        const appended = await appendWaiting(entry);
        if (appended !== undefined) queue.push({ branch: entry.branch, change: appended });
      }

      for (const [id, { history }] of branches) {
        const retried = await history.retry();
        queue.push({ branch: id, change: retried });
      }
    }

    return changes;
  }

  // Appends an entry that waited for its branch, if the branch is here now. One the history
  // refuses is dropped: its caller is long gone, and a valid entry with its number can still come.
  async function appendWaiting(entry: Entry) {
    const found = branches.get(entry.branch);

    if (found === undefined) {
      waitingEntries.push(entry);
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

  async function pendNow(batch: Batch, hash: string) {
    const found = branches.get(batch.branch);

    if (found === undefined) {
      waitingBatches.push({ batch, hash });
      return none();
    }

    const change = await found.history.pend(batch, hash);
    return settle(none(), batch.branch, change);
  }

  async function appendNow(entry: Entry) {
    const found = branches.get(entry.branch);

    if (found === undefined) {
      waitingEntries.push(entry);
      return none();
    }

    const change = await found.history.append(entry);
    return settle(none(), entry.branch, change);
  }

  async function sequenceNow(peer: CryptoKeyPair) {
    const self = await keyIdOf(peer.publicKey);
    const changes = none();
    const made: Entry[] = [];

    // A branch this sequencing opens is in the map by the time the loop reaches it.
    for (const [id, { branch, history }] of branches) {
      if (branch.sequencer !== self || closed.has(id)) continue;
      const { entries, change } = await history.sequence(peer);
      made.push(...entries);
      await settle(changes, id, change);
    }

    return { entries: made, changes };
  }

  return {
    // jscpd:ignore-start: the same calls as createHistory's, for every branch
    /** Takes a verified batch, for its branch's history, or to wait until the branch is created. */
    pend: (batch: Batch, hash: string) => serial(() => pendNow(batch, hash)),
    /**
     * Takes an entry from a branch's sequencer, for its branch's history, or to wait until the
     * branch is created. Throws as the history's `append` does.
     */
    append: (entry: Entry) => serial(() => appendNow(entry)),
    /**
     * Appends what every open branch this peer sequences has received, as `createHistory`'s
     * `sequence` does. Returns the entries to publish. A batch merging entries this peer didn't
     * have waits for the next call after they arrive.
     */
    sequence: (peer: CryptoKeyPair) => serial(() => sequenceNow(peer)),
    // jscpd:ignore-end
    /** The branches, main first, then in the order they were created here. */
    branches: (): ReadonlyArray<Readonly<Branch>> =>
      [...branches.values()].map(({ branch }) => branch),
    /** A branch's history, to read, or undefined for a branch not created here. */
    history: (id: BranchId) => {
      const found = branches.get(id);
      return found === undefined ? undefined : readOnly(found.history);
    },
  };
}

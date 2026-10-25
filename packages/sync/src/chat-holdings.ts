// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// What a peer holds of each author's chat, to answer repairs (docs/architecture.md#gaps-and-repair):
// the messages, and for each run of chained seqs, the checkpoint with the highest seq. Every
// batch ends with a checkpoint, so an honest author's runs each end at one; keeping just that one
// per run lets the peer prove any message it holds, and drops the rest. When a gap fills, two
// runs join, and the lower run's checkpoint goes. Runs join only where a message's `prev` names
// the one held below it: an author that forks its chain leaves separate runs, each still proven
// by its own checkpoint.

import type { ChatBatch } from "./chat-batch";
import { messageHash, type ChatMessage, type Checkpoint } from "./chat";
import type { KeyId } from "./crypto";

type Author = {
  messages: Map<number, ChatMessage>;
  hashes: Map<number, string>;
  checkpoints: Map<number, Checkpoint>;
  newest: number;
};

/** One run of chained seqs held, inclusive. */
type Run = { first: number; last: number };

export function createChatHoldings() {
  const authors = new Map<KeyId, Author>();
  // Adds run one after another, so the first copy of a seq is the one added first, however long
  // each batch takes to hash.
  let added: Promise<void> = Promise.resolve();

  function holding(author: KeyId) {
    const held = authors.get(author) ?? {
      messages: new Map(),
      hashes: new Map(),
      checkpoints: new Map(),
      newest: 0,
    };
    authors.set(author, held);
    return held;
  }

  // Whether the message held at `seq` chains to the one held below it.
  const linked = ({ messages, hashes }: Author, seq: number) =>
    hashes.has(seq - 1) && messages.get(seq)?.prev === hashes.get(seq - 1);

  // The first seq of the run of chained held seqs that contains `seq`.
  function firstOf(held: Author, seq: number) {
    let first = seq;
    while (linked(held, first)) first--;
    return first;
  }

  // The run of chained held seqs that contains `seq`.
  function runOf(held: Author, seq: number): Run {
    let last = seq;
    while (linked(held, last + 1)) last++;
    return { first: firstOf(held, seq), last };
  }

  /**
   * Adds a batch the peer has decoded. The first message held for each seq stays, and a
   * checkpoint is kept only if it names the message held at its seq. Then only the checkpoint
   * with the highest seq in each run is kept.
   */
  const add = ({ messages, checkpoint }: ChatBatch) =>
    queued(checkpoint.author, messages, [checkpoint]);

  /**
   * Restores what the local store kept of an author after a reload, as if its batches had been
   * added again: the messages up to the newest checkpoint, and the checkpoints. Messages after
   * it, this peer's own unsent ones, stay out, as they would until their batch came back.
   */
  function restore(author: KeyId, messages: ChatMessage[], checkpoints: Checkpoint[]) {
    const newest = checkpoints.reduce((max, cp) => Math.max(max, cp.seq), 0);
    const proven = messages.filter((m) => m.seq <= newest);
    return queued(author, proven, checkpoints);
  }

  function queued(author: KeyId, messages: ChatMessage[], checkpoints: Checkpoint[]) {
    const next = hold(added, author, messages, checkpoints);
    added = next;
    return next;
  }

  async function hold(
    before: Promise<void>,
    author: KeyId,
    messages: ChatMessage[],
    checkpoints: Checkpoint[],
  ) {
    await before;
    const held = holding(author);
    const fresh = messages.filter((m) => !held.messages.has(m.seq));
    const hashes = await Promise.all(fresh.map(messageHash));

    for (const [i, m] of fresh.entries()) {
      held.messages.set(m.seq, m);
      held.hashes.set(m.seq, hashes[i]!);
    }

    for (const checkpoint of checkpoints) {
      held.newest = Math.max(held.newest, checkpoint.seq);
      const proves = held.hashes.get(checkpoint.seq) === checkpoint.head;
      if (proves) held.checkpoints.set(checkpoint.seq, checkpoint);
    }

    // Highest first: a checkpoint below the start of the last kept one's run is in another run.
    // Each run is walked once, so a restore with a checkpoint per batch stays linear.
    const kept = new Map<number, Checkpoint>();
    let floor = Infinity;

    // copy: a Map can't be sorted, so its checkpoints go into an array, highest first.
    const highestFirst = [...held.checkpoints];
    highestFirst.sort(([a], [b]) => b - a);

    for (const [seq, cp] of highestFirst) {
      if (seq >= floor) continue;

      kept.set(seq, cp);
      floor = firstOf(held, seq);
    }

    held.checkpoints = kept;
  }

  // The batch proving `from` and every later message in its run up to the run's checkpoint, or
  // undefined. Only a forked chain leaves messages past a run's checkpoint; they can't be proven.
  function batchFrom(held: Author, from: number): ChatBatch | undefined {
    if (!held.messages.has(from)) return undefined;

    const { first } = runOf(held, from);
    const checkpoint = held.checkpoints
      .values()
      .find((cp) => cp.seq >= from && runOf(held, cp.seq).first === first);
    if (checkpoint === undefined) return undefined;

    const messages = Array.from({ length: checkpoint.seq - from + 1 }, (_, i) =>
      held.messages.get(from + i)!,
    );
    return { messages, checkpoint };
  }

  /**
   * The reply to a repair asking for an author's messages from `firstSeq`: everything held from
   * there to its run's checkpoint. Undefined, for the asker to try the next peer, when
   * `firstSeq` isn't held or can't be proven.
   */
  const repair = (author: KeyId, firstSeq: number) => {
    const held = authors.get(author);
    return held === undefined ? undefined : batchFrom(held, firstSeq);
  };

  /**
   * The reply to a version vector: for each author, one batch per run held beyond the asker's
   * seq, authors it didn't name included.
   */
  function after(versions: Record<KeyId, number>) {
    const batches: ChatBatch[] = [];

    for (const [author, held] of authors) {
      const known = versions[author] ?? 0;
      const seqs = held.messages
        .keys()
        .filter((s) => s > known)
        .toArray();
      seqs.sort((a, b) => a - b);

      for (const seq of seqs) {
        if (seq !== known + 1 && linked(held, seq)) continue;

        const batch = batchFrom(held, seq);
        if (batch !== undefined) batches.push(batch);
      }
    }

    return batches;
  }

  /** The checkpoints kept for an author, in seq order: one per run. */
  const checkpoints = (author: KeyId) => {
    // copy: a Map can't be sorted, so its checkpoints go into an array, in seq order.
    const ordered = [...(authors.get(author)?.checkpoints.values() ?? [])];
    ordered.sort((a, b) => a.seq - b.seq);
    return ordered;
  };

  /** The highest seq held from an author, or 0. */
  const newest = (author: KeyId) => authors.get(author)?.newest ?? 0;

  return { add, restore, repair, after, checkpoints, newest };
}

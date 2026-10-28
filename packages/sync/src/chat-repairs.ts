// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Asking for missing chat (docs/architecture.md#gaps-and-repair). There is no timeout, since a
// link that dies closes, and that moves the ask to the next candidate.

import type { KeyId } from "./crypto";
import { rank } from "./rank";

type Ask = {
  author: KeyId;
  firstSeq: number;
  candidates: KeyId[];
  asked: number;
  /** Whether a candidate was passed over because its link closed, not because it failed. */
  passed: boolean;
};

// copy: sorted without reordering the caller's.
const together = (candidates: KeyId[]) => candidates.toSorted().join("\n");

export function createChatRepairs(send: (peer: KeyId, author: KeyId, firstSeq: number) => void) {
  // One ask per author: an earlier gap replaces a later one, which it covers.
  const asks = new Map<KeyId, Ask>();
  const contiguous = new Map<KeyId, number>();
  // Per author, a gap every candidate failed to fill, and who they were: not asked again, on the
  // next gap event, until the candidates change or one of them has closed its link.
  const exhausted = new Map<KeyId, { firstSeq: number; candidates: string }>();

  function next(ask: Ask) {
    ask.asked++;
    const peer = ask.candidates[ask.asked];

    if (peer === undefined) {
      asks.delete(ask.author);

      if (!ask.passed) {
        exhausted.set(ask.author, { firstSeq: ask.firstSeq, candidates: together(ask.candidates) });
      }

      return;
    }

    send(peer, ask.author, ask.firstSeq);
  }

  /**
   * A gap from `firstSeq` in an author's messages: asks the best-ranked candidate, the author
   * itself if online and the peer's connected group peers. Replaces any earlier ask for the
   * author that starts later.
   */
  async function gap(author: KeyId, firstSeq: number, candidates: KeyId[]) {
    const ranked = await rank(candidates, author, firstSeq);
    // Looked at after ranking: a batch received meanwhile may have filled the gap.
    if (firstSeq <= (contiguous.get(author) ?? 0)) return;

    const current = asks.get(author);
    if (current !== undefined && current.firstSeq <= firstSeq) return;

    const failed = exhausted.get(author);
    if (failed?.firstSeq === firstSeq && failed.candidates === together(ranked)) return;

    const ask = { author, firstSeq, candidates: ranked, asked: -1, passed: false };
    asks.set(author, ask);
    next(ask);
  }

  /** The asked peer holds none of it: ask the next. */
  function gone(peer: KeyId, author: KeyId, firstSeq: number) {
    const ask = asks.get(author);
    if (ask?.firstSeq === firstSeq && ask.candidates[ask.asked] === peer) next(ask);
  }

  /** The peer sent a reply that didn't prove itself: every ask waiting on it moves to the next. */
  function refused(peer: KeyId) {
    for (const ask of asks.values()) {
      if (ask.candidates[ask.asked] === peer) next(ask);
    }
  }

  /**
   * The peer's link closed: every ask waiting on it moves to the next. It didn't fail, so a gap
   * that runs out of candidates this way, or that it failed before, is asked again later.
   */
  function closed(peer: KeyId) {
    for (const [author, failed] of exhausted) {
      if (failed.candidates.split("\n").includes(peer)) exhausted.delete(author);
    }

    for (const ask of asks.values()) {
      if (ask.candidates[ask.asked] !== peer) continue;
      ask.passed = true;
      next(ask);
    }
  }

  /**
   * The author's messages are now held up to `seq`, with none missing below. An ask that seq
   * reaches is done; the receiver asks again from `seq + 1` if more is missing.
   */
  function filled(author: KeyId, seq: number) {
    contiguous.set(author, seq);
    const ask = asks.get(author);
    if (ask !== undefined && ask.firstSeq <= seq) asks.delete(author);
  }

  /**
   * A reply from `peer` proved itself, and the author's messages are held up to `seq`: if it
   * didn't reach the ask waiting on that peer, that counts as `gone`.
   */
  function answered(peer: KeyId, author: KeyId, seq: number) {
    const ask = asks.get(author);
    if (ask !== undefined && ask.firstSeq > seq) gone(peer, author, ask.firstSeq);
  }

  return { gap, gone, refused, closed, filled, answered };
}

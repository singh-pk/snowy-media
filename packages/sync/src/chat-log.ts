// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A peer's chat log (docs/architecture.md#chat), ordered by (hlc, author). Edits, deletes and
// reactions are messages too, and what is shown is worked out from the whole log, so it is the
// same on every peer that holds the same messages, whatever order they arrived in.

import type { ChatMessage, ChatTarget } from "./chat";
import type { KeyId } from "./crypto";
import type { Hlc } from "./hlc";

/** A text message as shown: its latest edit and its current reactions. */
export type ChatEntry = {
  author: KeyId;
  seq: number;
  hlc: string;
  mediaUs: number;
  text: string;
  edited: boolean;
  /**
   * Whether the message sorts below the clock this peer had when it arrived, as one written
   * offline does. Local to each peer, since it depends on when the message reached it.
   */
  late: boolean;
  /** Each emoji with the peers that reacted with it, in the order of their latest reactions. */
  reactions: Array<{ emoji: string; peers: KeyId[] }>;
};

/** The messages missing from one author: seqs `firstSeq` to `lastSeq`, inclusive. */
export type Gap = { author: KeyId; firstSeq: number; lastSeq: number };

const key = ({ author, seq }: ChatTarget) => `${author}/${seq}`;

const compare = (a: ChatMessage, b: ChatMessage) =>
  a.hlc !== b.hlc
    ? a.hlc < b.hlc
      ? -1
      : 1
    : a.author !== b.author
      ? a.author < b.author
        ? -1
        : 1
      : a.seq - b.seq;

function position(ordered: ChatMessage[], message: ChatMessage) {
  let low = 0;
  let high = ordered.length;

  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compare(ordered[mid]!, message) < 0) low = mid + 1;
    else high = mid;
  }

  return low;
}

type Author = { seqs: Set<number>; newest: number; contiguous: number };

export function createChatLog() {
  const authors = new Map<KeyId, Author>();
  const ordered: ChatMessage[] = [];
  const late = new Set<string>();

  /**
   * Adds the peer's own message, one from its author's track, or one a checkpoint has proven
   * (`proven` in src/chat.ts); never a repaired message before that. The first message held for
   * each `(author, seq)` stays, and another returns `added: false`. `clock` is the peer's clock
   * before the message arrived: one that sorts below it is marked late. `gap` is the seqs from its
   * author that this message skips past, if any.
   */
  function add(message: ChatMessage, clock: Hlc): { added: boolean; gap?: Gap } {
    const author = authors.get(message.author) ?? { seqs: new Set(), newest: 0, contiguous: 0 };
    authors.set(message.author, author);
    if (author.seqs.has(message.seq)) return { added: false };

    ordered.splice(position(ordered, message), 0, message);
    if (message.hlc < clock) late.add(key(message));

    const gap =
      message.seq > author.newest + 1
        ? { author: message.author, firstSeq: author.newest + 1, lastSeq: message.seq - 1 }
        : undefined;
    author.seqs.add(message.seq);
    author.newest = Math.max(author.newest, message.seq);
    while (author.seqs.has(author.contiguous + 1)) author.contiguous++;
    return gap === undefined ? { added: true } : { added: true, gap };
  }

  /**
   * The version vector sent on reconnect: for each author, the highest seq held with none
   * missing below it, so a reply also fills the gaps.
   */
  const versions = () =>
    Object.fromEntries(authors.entries().map(([author, { contiguous }]) => [author, contiguous]));

  /**
   * The text messages to show, in order, with edits, deletes and reactions applied. Only a
   * message's own author can edit or delete it.
   */
  function entries(): ChatEntry[] {
    const edits = new Map<string, string>();
    const deleted = new Set<string>();
    // For each target, each reactor and emoji's latest reaction and whether it stands. A later one
    // replaces it at the end, so a target's reactions stay in the order of their latest.
    const reactions = new Map<
      string,
      Map<string, { reactor: KeyId; emoji: string; on: boolean }>
    >();

    for (const m of ordered) {
      if (m.target === undefined) continue;

      const target = key(m.target);
      const own = m.author === m.target.author;
      if (m.kind === "edit" && own) edits.set(target, m.text!);
      if (m.kind === "delete" && own) deleted.add(target);

      if (m.kind === "react") {
        const forTarget = reactions.get(target) ?? new Map();
        reactions.set(target, forTarget);
        forTarget.delete(`${m.author}\n${m.emoji}`);
        forTarget.set(`${m.author}\n${m.emoji}`, {
          reactor: m.author,
          emoji: m.emoji!,
          on: m.text !== "",
        });
      }
    }

    return ordered
      .filter((m) => m.kind === "text" && !deleted.has(key(m)))
      .map((m) => ({
        author: m.author,
        seq: m.seq,
        hlc: m.hlc,
        mediaUs: m.mediaUs,
        text: edits.get(key(m)) ?? m.text!,
        edited: edits.has(key(m)),
        late: late.has(key(m)),
        reactions: grouped(reactions.get(key(m))),
      }));
  }

  return { add, versions, entries };
}

function grouped(reactions?: Map<string, { reactor: KeyId; emoji: string; on: boolean }>) {
  const byEmoji = Map.groupBy(reactions?.values().filter((r) => r.on) ?? [], (r) => r.emoji);
  return Array.from(byEmoji, ([emoji, held]) => ({ emoji, peers: held.map((r) => r.reactor) }));
}

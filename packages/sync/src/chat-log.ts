// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A peer's chat log (docs/architecture.md#chat): the messages it shows, in the order every peer
// shows them, by (hlc, author). Chat is append-only, so edits, deletes and reactions are
// messages too; what the interface shows is worked out from the whole log, and so is the same
// on every peer that holds the same messages, whatever order they arrived in.

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
   * It sorts below the clock this peer had when it arrived, such as one written offline. Local
   * to each peer: it depends on when the message reached it.
   */
  late: boolean;
  /** Each emoji with the peers that reacted with it, in the order of their latest reactions. */
  reactions: Array<{ emoji: string; peers: KeyId[] }>;
};

/** Messages missing from one author, inclusive. */
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

// The index a message sorts at.
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
   * Adds a message to show: the peer's own, one from its author's track, or one a checkpoint
   * proved (`proven`), never a repaired one before that. The first message held for each
   * `(author, seq)` stays; a later one is ignored. `clock` is the peer's clock value before it
   * received the message: a message that sorts below it arrived late. Returns whether the
   * message was new, and the gap before it if the author's newest message was more than one
   * seq behind.
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

  /** The text messages to show, in order, with edits, deletes and reactions applied. */
  function entries(): ChatEntry[] {
    const edits = new Map<string, string>();
    const deleted = new Set<string>();
    // target, then reactor and emoji, to whether the reaction stands; later messages win.
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

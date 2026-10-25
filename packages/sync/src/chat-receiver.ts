// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Receiving chat (docs/architecture.md#chat). A batch proves itself, so one path takes them all:
// from an author's track, from a repair reply, and this peer's own as it publishes them. Each
// message moves the clock and goes into the log; the batch goes into the holdings, to answer
// others' repairs, after the whole batch is in the local store; and a seq still missing below the
// newest one held is asked for. After a reload, the store's records restore the holdings, the
// log and the clock.

import { decodeBatch } from "./chat-batch";
import type { createChatHoldings } from "./chat-holdings";
import type { createChatLog } from "./chat-log";
import type { createChatRepairs } from "./chat-repairs";
import type { ChatAppend, ChatRecords } from "./chat-store";
import type { Bytes, KeyId } from "./crypto";
import type { createClock } from "./hlc";

// A clock value below every message's, so `log.add` marks none late.
const NOT_LATE = "0000000000000000";

export type ChatReceiverOptions = {
  content: CryptoKey;
  clock: ReturnType<typeof createClock>;
  log: ReturnType<typeof createChatLog>;
  holdings: ReturnType<typeof createChatHoldings>;
  repairs: ReturnType<typeof createChatRepairs>;
  /** The local store (`openChatStore`), which takes each whole batch before the holdings do. */
  store: { append(author: KeyId, records: ChatAppend): unknown };
  /** Who to ask for an author's missing messages: the author if online, and group peers. */
  candidates(author: KeyId): KeyId[];
};

export function createChatReceiver(options: ChatReceiverOptions) {
  const { log, clock, holdings, repairs, store } = options;

  async function decoded(key: string, bytes: Bytes, responder?: KeyId) {
    try {
      return await decodeBatch(options.content, key, bytes);
    } catch (error) {
      // A reply that doesn't prove itself answers nothing: ask the next peer.
      if (responder !== undefined) repairs.refused(responder);
      throw error;
    }
  }

  /**
   * Takes a batch object, with the peer that sent it when it answers this peer's repair.
   * Rejects, changing nothing, for one that doesn't decode and prove itself (`decodeBatch`).
   */
  async function receive(key: string, bytes: Bytes, responder?: KeyId) {
    const batch = await decoded(key, bytes, responder);
    const { author } = batch.checkpoint;
    // Stored first: a batch the store fails to take changes nothing, and comes again whole.
    await store.append(author, batch);
    await holdings.add(batch);

    for (const message of batch.messages) {
      const before = clock.value();
      clock.receive(message.hlc);
      log.add(message, before);
    }

    const contiguous = log.versions()[author] ?? 0;
    repairs.filled(author, contiguous);
    if (responder !== undefined) repairs.answered(responder, author, contiguous);

    if (holdings.newest(author) > contiguous) {
      await repairs.gap(author, contiguous + 1, options.candidates(author));
    }
  }

  /**
   * Restores what the local store held at opening, before anything is received. Messages
   * written but never proven, this peer's own unsent ones, go into the log but not the holdings,
   * so they aren't offered to others until their batch comes back. It asks for no gaps: the
   * version vector sent on reconnect fills them.
   */
  async function restore(records: ReadonlyMap<KeyId, ChatRecords>) {
    const restores = Array.from(records, ([author, { messages, checkpoints }]) =>
      holdings.restore(author, messages, checkpoints),
    );
    await Promise.all(restores);

    for (const { messages } of records.values()) {
      for (const message of messages) {
        clock.receive(message.hlc);
        // Shown before: none of them is late now.
        log.add(message, NOT_LATE);
      }
    }
  }

  return { receive, restore };
}

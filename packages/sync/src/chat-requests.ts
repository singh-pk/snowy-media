// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The messages that repair chat between two peers (docs/architecture.md#gaps-and-repair), sent
// with a link's `send`, and the side that answers them. A peer with a gap sends `chat-request`
// for an author's messages from a seq; on reconnect it sends `chat-versions` once. The responder
// answers from its holdings with batches, through the link's `deliver`, or with `chat-gone` when
// it holds none of what was asked. Every field from a peer is checked before it is used.

import { sealBatch, type ChatBatch } from "./chat-batch";
import { isCount, isRecord } from "./chat";
import type { createChatHoldings } from "./chat-holdings";
import { isKeyId, type Bytes, type KeyId } from "./crypto";

/** Asks for an author's messages from `firstSeq`. */
type ChatRequest = { type: "chat-request"; author: KeyId; firstSeq: number };
/** The responder holds none of what a `chat-request` asked for. */
type ChatGone = { type: "chat-gone"; author: KeyId; firstSeq: number };
/** Asks for every message beyond these seqs, each the highest held with none missing below. */
type ChatVersions = { type: "chat-versions"; versions: Record<KeyId, number> };

export type ChatControl = ChatRequest | ChatGone | ChatVersions;

const isVersions = (value: unknown): value is Record<KeyId, number> =>
  isRecord(value) && Object.entries(value).every(([a, seq]) => isKeyId(a) && isCount(seq, 0));

/** A chat message received from a peer, checked, or undefined for anything else. */
export function checkChatControl(value: unknown): ChatControl | undefined {
  if (!isRecord(value)) return undefined;

  const { type, author, firstSeq, versions } = value;

  if (type === "chat-request" || type === "chat-gone") {
    return isKeyId(author) && isCount(firstSeq, 1) ? { type, author, firstSeq } : undefined;
  }

  if (type === "chat-versions" && isVersions(versions)) {
    return { type, versions };
  }

  return undefined;
}

export type ChatResponderOptions = {
  /** The key this peer seals with: in a watch session, the content key. */
  content: CryptoKey;
  holdings: ReturnType<typeof createChatHoldings>;
  /** Sends a message to a peer over its link. */
  send(peer: KeyId, message: ChatGone): void;
  /** Sends an object to a peer that asked for it, on its `deliver` track. */
  deliver(peer: KeyId, key: string, bytes: Bytes): void;
};

/** Answers other peers' chat requests from this peer's holdings. */
export function createChatResponder(options: ChatResponderOptions) {
  const { holdings } = options;

  // A reply sealed, or undefined if there is none or sealing it failed: a stored message that
  // no longer checks, say. Repair moves only on events, so a reply that can't be sent must
  // still answer, with chat-gone.
  async function sealed(reply: ChatBatch | undefined) {
    if (reply === undefined) return undefined;

    try {
      return await sealBatch(options.content, reply);
    } catch {
      return undefined;
    }
  }

  /** Answers a `chat-request` or `chat-versions` from `peer`; any other message is ignored. */
  async function requested(peer: KeyId, message: ChatControl) {
    if (message.type === "chat-request") {
      const { author, firstSeq } = message;
      const reply = holdings.repair(author, firstSeq);
      const object = await sealed(reply);
      if (object === undefined) options.send(peer, { type: "chat-gone", author, firstSeq });
      else options.deliver(peer, object.key, object.bytes);
      return;
    }

    if (message.type === "chat-versions") {
      // One at a time, so only one sealed reply is held at once and the first goes out without
      // waiting for the rest. Each proves itself, so the order they arrive in doesn't matter, and
      // one that fails to seal leaves a gap the asker repairs as any other.
      for (const reply of holdings.after(message.versions)) {
        const object = await sealed(reply);
        if (object !== undefined) options.deliver(peer, object.key, object.bytes);
      }
    }
  }

  return { requested };
}

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The chat batch (docs/architecture.md#sending). A batch always empties the author's queue and
// ends with the author's checkpoint at its last message, so it checks out on its own, wherever it
// came from.

import {
  checkCheckpoint,
  checkMessage,
  proven,
  signCheckpoint,
  type ChatMessage,
  type Checkpoint,
} from "./chat";
import { seal, unseal, type Bytes, type KeyId } from "./crypto";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const KEY = /^chat\/([A-Za-z0-9_-]{43})\/([1-9]\d*)-([1-9]\d*)$/;

export type ChatBatch = { messages: ChatMessage[]; checkpoint: Checkpoint };

/** Thrown for a batch that doesn't open, doesn't parse, or doesn't prove itself. */
export class InvalidBatchError extends Error {
  constructor(reason: string) {
    super(`Invalid chat batch: ${reason}`);
    this.name = "InvalidBatchError";
  }
}

export const batchKey = (author: KeyId, firstSeq: number, lastSeq: number) =>
  `chat/${author}/${firstSeq}-${lastSeq}`;

/**
 * Seals the author's queued messages, in seq order, as one batch with a checkpoint at the last,
 * signed with the author's key. Resolves with the object key and the sealed bytes; rejects with a
 * `RangeError` for no messages.
 */
export async function encodeBatch(
  peer: CryptoKeyPair,
  content: CryptoKey,
  messages: ChatMessage[],
) {
  const last = messages.at(-1);
  if (last === undefined) throw new RangeError("a batch has a message");

  const checkpoint = await signCheckpoint(peer, last);
  return sealBatch(content, { messages, checkpoint });
}

/**
 * Seals a batch from messages and a checkpoint already signed: how any peer that holds them
 * answers a repair. The messages must be one author's, consecutive and ending at the checkpoint,
 * or it rejects with a `RangeError`; it rejects with an `InvalidMessageError` for a malformed one.
 */
export async function sealBatch(content: CryptoKey, { messages, checkpoint }: ChatBatch) {
  const first = messages[0];
  if (first === undefined) throw new RangeError("a batch has a message");

  const { author } = checkpoint;
  const consecutive = messages.every((m, i) => m.author === author && m.seq === first.seq + i);

  if (!consecutive || messages.at(-1)!.seq !== checkpoint.seq) {
    throw new RangeError("a batch is the author's consecutive messages, ending at its checkpoint");
  }

  const key = batchKey(author, first.seq, checkpoint.seq);
  const plaintext = encoder.encode(
    JSON.stringify({ messages: messages.map(checkMessage), checkpoint }),
  );
  const bytes = await seal(content, key, plaintext);
  return { key, bytes };
}

async function opened(content: CryptoKey, key: string, bytes: Bytes) {
  try {
    return await unseal(content, key, bytes);
  } catch {
    throw new InvalidBatchError("doesn't open under the content key");
  }
}

function parse(plaintext: Bytes) {
  try {
    return JSON.parse(decoder.decode(plaintext)) as unknown;
  } catch {
    throw new InvalidBatchError("not UTF-8 JSON");
  }
}

// The body's fields, checked against what the key names.
function checkBody(value: unknown, author: string, firstSeq: number, lastSeq: number): ChatBatch {
  const body = typeof value === "object" && value !== null ? value : {};
  const raw = "messages" in body ? body.messages : undefined;

  if (!Array.isArray(raw) || Object.keys(body).length !== 2) {
    throw new InvalidBatchError("bad body");
  }

  const messages = raw.map((m: unknown) => checkMessage(m));
  const consecutive = messages.every((m, i) => m.author === author && m.seq === firstSeq + i);

  if (!consecutive || messages.length !== lastSeq - firstSeq + 1) {
    throw new InvalidBatchError("messages don't match the key");
  }

  const checkpoint = checkCheckpoint("checkpoint" in body ? body.checkpoint : undefined);

  if (checkpoint?.author !== author || checkpoint.seq !== lastSeq) {
    throw new InvalidBatchError("bad checkpoint");
  }

  return { messages, checkpoint };
}

/**
 * Opens and checks a batch: it decrypts under its key, holds exactly the author's messages the
 * key names, and its checkpoint proves every one. Rejects with an `InvalidMessageError` for a
 * malformed message, and with an `InvalidBatchError` for any other failure.
 */
export async function decodeBatch(
  content: CryptoKey,
  key: string,
  bytes: Bytes,
): Promise<ChatBatch> {
  const match = KEY.exec(key);
  if (match === null) throw new InvalidBatchError(`not a batch key: ${key}`);

  const [, author = "", first = "", last = ""] = match;
  const plaintext = await opened(content, key, bytes);

  const batch = checkBody(parse(plaintext), author, Number(first), Number(last));
  const chain = await proven(batch.messages, batch.checkpoint);
  if (chain.length !== batch.messages.length)
    throw new InvalidBatchError("not proven by its checkpoint");
  return batch;
}

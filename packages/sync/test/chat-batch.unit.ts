// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The chat batch (src/chat-batch.ts), in Chromium: a batch round-trips with its checkpoint, proves
// itself, and is rejected when it doesn't open, isn't JSON, is moved to another key, or holds
// messages its key or checkpoint doesn't name.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import {
  batchKey,
  decodeBatch,
  encodeBatch,
  InvalidBatchError,
  sealBatch,
} from "../src/chat-batch";
import { signCheckpoint, type ChatMessage } from "../src/chat";
import { contentKey, seal } from "../src/crypto";
import { createAuthor } from "./support/chat";
import { rejection } from "./support/rejection";

const alice = await createAuthor(() => 1000);
const bob = await createAuthor(() => 2000);
const content = await contentKey(crypto.getRandomValues(new Uint8Array(32)), "session");
const m1 = await alice.write({ kind: "text", text: "one" });
const m2 = await alice.write({ kind: "text", text: "two" });
const m3 = await alice.write({ kind: "text", text: "three" });
const encoder = new TextEncoder();

// Seals any body under a key, as a peer with a bug, or a hostile one, could.
async function sealed(key: string, body: unknown) {
  const bytes = await seal(content, key, encoder.encode(JSON.stringify(body)));
  return { key, bytes };
}

async function invalid(key: string, bytes: Uint8Array<ArrayBuffer>) {
  const error = await rejection(decodeBatch(content, key, bytes));
  return error instanceof InvalidBatchError ? error.message : String(error);
}

test("a batch round-trips with a checkpoint at its last message", async () => {
  const { key, bytes } = await encodeBatch(alice.pair, content, [m2, m3]);
  expect(key).toBe(`chat/${alice.id}/2-3`);
  const batch = await decodeBatch(content, key, bytes);
  expect(batch.messages).toEqual([m2, m3]);
  expect(batch.checkpoint.author).toBe(alice.id);
  expect(batch.checkpoint.seq).toBe(3);
});

test("only the author's consecutive messages make a batch", async () => {
  const theirs = await bob.write({ kind: "text", text: "bob" });
  const errors = await Promise.all([
    rejection(encodeBatch(alice.pair, content, [])),
    rejection(encodeBatch(alice.pair, content, [m1, m3])),
    rejection(encodeBatch(alice.pair, content, [theirs])),
  ]);
  for (const error of errors) expect(error).toBeInstanceOf(RangeError);
});

test("a batch is sealed only with a checkpoint at its last message, by its author", async () => {
  const bobs = await bob.write({ kind: "text", text: "bob" });
  const [atTwo, theirs] = await Promise.all([
    signCheckpoint(alice.pair, m2),
    signCheckpoint(bob.pair, bobs),
  ]);
  const errors = await Promise.all([
    rejection(sealBatch(content, { messages: [m1, m2, m3], checkpoint: atTwo })),
    rejection(sealBatch(content, { messages: [m1, m2], checkpoint: theirs })),
  ]);
  for (const error of errors) expect(error).toBeInstanceOf(RangeError);
});

test("a batch doesn't open under another key, another content key, altered, or as anything but JSON", async () => {
  const { key, bytes } = await encodeBatch(alice.pair, content, [m1, m2]);
  const otherContent = await contentKey(crypto.getRandomValues(new Uint8Array(32)), "session");
  const altered = bytes.slice();
  altered[20] = (altered[20] ?? 0) ^ 1;
  const notJson = await seal(content, key, encoder.encode("{"));
  const errors = await Promise.all([
    invalid(batchKey(alice.id, 2, 3), bytes),
    rejection(decodeBatch(otherContent, key, bytes)),
    invalid(key, altered),
    invalid("chat/nobody/1-2", bytes),
    invalid(`chat/${alice.id}/01-2`, bytes),
    invalid(key, notJson),
  ]);
  expect(errors[0]).toBe("Invalid chat batch: doesn't open under the content key");
  expect(errors[1]).toBeInstanceOf(InvalidBatchError);
  expect(errors[2]).toBe("Invalid chat batch: doesn't open under the content key");
  expect(errors[3]).toBe("Invalid chat batch: not a batch key: chat/nobody/1-2");
  expect(errors[4]).toBe(`Invalid chat batch: not a batch key: chat/${alice.id}/01-2`);
  expect(errors[5]).toBe("Invalid chat batch: not UTF-8 JSON");
});

test("a batch whose messages or checkpoint don't match its key, or don't chain, is rejected", async () => {
  const cp2 = await signCheckpoint(alice.pair, m2);
  const cp3 = await signCheckpoint(alice.pair, m3);
  const bobsCp = await signCheckpoint(bob.pair, bob.sent[0]!);
  const forged: ChatMessage = { ...m2, text: "forged" };
  const key = batchKey(alice.id, 2, 3);

  const cases = await Promise.all([
    sealed(key, { messages: [m2, m3], checkpoint: cp3, extra: 1 }),
    sealed(key, { messages: [m2], checkpoint: cp2 }),
    sealed(key, { messages: [m3, m2], checkpoint: cp3 }),
    sealed(key, { messages: [m2, m3], checkpoint: cp2 }),
    sealed(key, { messages: [m2, m3], checkpoint: bobsCp }),
    sealed(key, { messages: [m2, m3], checkpoint: { ...cp3, sig: "x" } }),
    sealed(key, { messages: [forged, m3], checkpoint: cp3 }),
    sealed(key, [m2, m3]),
  ]);
  const errors = await Promise.all(cases.map((c) => invalid(c.key, c.bytes)));
  expect(errors).toEqual([
    "Invalid chat batch: bad body",
    "Invalid chat batch: messages don't match the key",
    "Invalid chat batch: messages don't match the key",
    "Invalid chat batch: bad checkpoint",
    "Invalid chat batch: bad checkpoint",
    "Invalid chat batch: bad checkpoint",
    "Invalid chat batch: not proven by its checkpoint",
    "Invalid chat batch: bad body",
  ]);
});

test("a malformed message in a batch is rejected", async () => {
  const cp1 = await signCheckpoint(alice.pair, m1);
  const { key, bytes } = await sealed(batchKey(alice.id, 1, 1), {
    messages: [{ ...m1, kind: "shout" }],
    checkpoint: cp1,
  });
  const error = await rejection(decodeBatch(content, key, bytes));
  expect(String(error)).toBe("InvalidMessageError: Invalid chat message: bad kind");
});

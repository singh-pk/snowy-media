// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Chat holdings (src/chat-holdings.ts), in Chromium: one checkpoint is kept per run of consecutive
// chained seqs, the lower one goes when a gap fills, a forked chain stays proven, and every repair or version-vector reply is a
// batch that seals and decodes, so it proves itself to the asker.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { decodeBatch, sealBatch, type ChatBatch } from "../src/chat-batch";
import { messageHash, signCheckpoint, type ChatMessage } from "../src/chat";
import { createChatHoldings } from "../src/chat-holdings";
import { contentKey } from "../src/crypto";
import { createAuthor } from "./support/chat";

const content = await contentKey(crypto.getRandomValues(new Uint8Array(32)), "session");
const alice = await createAuthor(() => 1000);
const bob = await createAuthor(() => 2000);

for (let i = 1; i <= 9; i++) await alice.write({ kind: "text", text: `a${i}` });
for (let i = 1; i <= 2; i++) await bob.write({ kind: "text", text: `b${i}` });

const seqs = (from: number, to: number) => alice.sent.slice(from - 1, to);

// The batch an author publishes: its messages and a checkpoint at the last.
async function batch(messages: ChatMessage[], pair = alice.pair): Promise<ChatBatch> {
  const checkpoint = await signCheckpoint(pair, messages.at(-1)!);
  return { messages, checkpoint };
}

// A reply as the asker gets it: sealed by the holder, decoded and proven.
async function delivered(reply: ChatBatch) {
  const { key, bytes } = await sealBatch(content, reply);
  return decodeBatch(content, key, bytes);
}

const span = (b?: ChatBatch) => b && [b.messages[0]!.seq, b.checkpoint.seq];

test("one checkpoint is kept per run of consecutive seqs", async () => {
  const holdings = createChatHoldings();
  const batches = await Promise.all([batch(seqs(1, 3)), batch(seqs(4, 5)), batch(seqs(8, 9))]);
  for (const b of batches) await holdings.add(b);
  expect(holdings.checkpoints(alice.id).map((cp) => cp.seq)).toEqual([5, 9]);
  expect(holdings.newest(alice.id)).toBe(9);
  expect(holdings.checkpoints(bob.id)).toEqual([]);
});

test("when a gap fills, the lower run's checkpoint goes", async () => {
  const holdings = createChatHoldings();
  const batches = await Promise.all([batch(seqs(1, 5)), batch(seqs(8, 9)), batch(seqs(6, 7))]);
  await holdings.add(batches[0]);
  await holdings.add(batches[1]);
  expect(holdings.checkpoints(alice.id).map((cp) => cp.seq)).toEqual([5, 9]);
  await holdings.add(batches[2]);
  expect(holdings.checkpoints(alice.id).map((cp) => cp.seq)).toEqual([9]);
});

test("a repair is answered from the asked seq to the end of its run, and proves itself", async () => {
  const holdings = createChatHoldings();
  const batches = await Promise.all([batch(seqs(1, 5)), batch(seqs(8, 9))]);
  for (const b of batches) await holdings.add(b);

  const reply = holdings.repair(alice.id, 2)!;
  expect(span(reply)).toEqual([2, 5]);
  const proven = await delivered(reply);
  expect(proven.messages).toEqual(seqs(2, 5));

  // A seq not held, or an author not known, gets no reply: the asker tries the next peer.
  expect(holdings.repair(alice.id, 6)).toBeUndefined();
  expect(holdings.repair(bob.id, 1)).toBeUndefined();
});

test("a version vector is answered with one batch per run beyond it, every author included", async () => {
  const holdings = createChatHoldings();
  const batches = await Promise.all([
    batch(seqs(1, 5)),
    batch(seqs(8, 9)),
    batch(bob.sent, bob.pair),
  ]);
  for (const b of batches) await holdings.add(b);

  const replies = holdings.after({ [alice.id]: 3 });
  expect(
    replies.map((r) => [r.checkpoint.author === alice.id ? "alice" : "bob", ...span(r)!]),
  ).toEqual([
    ["alice", 4, 5],
    ["alice", 8, 9],
    ["bob", 1, 2],
  ]);
  const proven = await Promise.all(replies.map(delivered));
  expect(proven.flatMap((b) => b.messages)).toEqual([...seqs(4, 5), ...seqs(8, 9), ...bob.sent]);
  expect(holdings.after({ [alice.id]: 9, [bob.id]: 2 })).toEqual([]);
});

// Another message at seq 4 that doesn't chain to 3, as an author forking its chain sends.
async function forked() {
  const prev = await messageHash(seqs(1, 1)[0]!);
  return { ...seqs(4, 4)[0]!, prev, text: "forked" };
}

test("the first message held for a seq stays, with only a checkpoint that names it", async () => {
  const holdings = createChatHoldings();
  const fork = await forked();
  const batches = await Promise.all([batch(seqs(1, 4)), batch([fork])]);
  await holdings.add(batches[0]);
  await holdings.add(batches[1]);
  expect(holdings.checkpoints(alice.id)).toEqual([batches[0].checkpoint]);
  const proven = await delivered(holdings.repair(alice.id, 1)!);
  expect(proven.messages).toEqual(seqs(1, 4));
});

test("the first message held for a seq stays when two batches are added at once", async () => {
  const holdings = createChatHoldings();
  const fork = await forked();
  const batches = await Promise.all([batch(seqs(1, 4)), batch([fork])]);
  await Promise.all([holdings.add(batches[0]), holdings.add(batches[1])]);
  expect(holdings.checkpoints(alice.id)).toEqual([batches[0].checkpoint]);
  const proven = await delivered(holdings.repair(alice.id, 1)!);
  expect(proven.messages).toEqual(seqs(1, 4));
});

test("a restore keeps one checkpoint per run, and leaves out messages past the newest", async () => {
  const holdings = createChatHoldings();
  const checkpoints = await Promise.all(
    alice.sent.slice(0, 7).map((m) => signCheckpoint(alice.pair, m)),
  );
  await holdings.restore(alice.id, seqs(1, 9), checkpoints);
  expect(holdings.checkpoints(alice.id).map((cp) => cp.seq)).toEqual([7]);
  expect(holdings.newest(alice.id)).toBe(7);
  expect(holdings.repair(alice.id, 8)).toBeUndefined();
  const proven = await delivered(holdings.repair(alice.id, 1)!);
  expect(proven.messages).toEqual(seqs(1, 7));
});

test("a restored run without a checkpoint of its own answers no repair", async () => {
  const holdings = createChatHoldings();
  const checkpoint = await signCheckpoint(alice.pair, seqs(7, 7)[0]!);
  await holdings.restore(alice.id, [...seqs(1, 3), ...seqs(5, 7)], [checkpoint]);
  expect(holdings.repair(alice.id, 1)).toBeUndefined();
  expect(span(holdings.repair(alice.id, 5))).toEqual([5, 7]);
});

test("a run doesn't join a message that doesn't chain to it, so both stay proven", async () => {
  const holdings = createChatHoldings();
  const fork = await forked();
  const batches = await Promise.all([batch(seqs(1, 3)), batch([fork])]);
  await holdings.add(batches[0]);
  await holdings.add(batches[1]);
  expect(holdings.checkpoints(alice.id).map((cp) => cp.seq)).toEqual([3, 4]);

  // Seqs 1 to 4 are all held, yet the reply from 1 stops where the chain does.
  const fromOne = await delivered(holdings.repair(alice.id, 1)!);
  expect(fromOne.messages).toEqual(seqs(1, 3));
  const fromFour = await delivered(holdings.repair(alice.id, 4)!);
  expect(fromFour.messages.map((m) => m.text)).toEqual(["forked"]);
});

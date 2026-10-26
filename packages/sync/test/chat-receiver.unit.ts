// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Receiving chat (src/chat-receiver.ts), in Chromium: two peers end to end. Batches from the
// author's track reach the log and move the clock; a lost batch is noticed and asked for, and a
// repair answered from the holdings of a third peer fills it; a batch that doesn't prove itself
// changes nothing. With a local store, a reload restores the log, the holdings and the clock,
// and this peer's unsent messages go with its first batch.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { sealBatch } from "../src/chat-batch";
import { createChatHoldings } from "../src/chat-holdings";
import { createChatLog } from "../src/chat-log";
import { createChatReceiver, type ChatReceiverOptions } from "../src/chat-receiver";
import { createChatRepairs } from "../src/chat-repairs";
import { createChatSender } from "../src/chat-sender";
import { openChatStore, unsent } from "../src/chat-store";
import { contentKey, generateKeyPair, keyId, type Bytes } from "../src/crypto";
import { createClock } from "../src/hlc";
import { rejection } from "./support/rejection";

const content = await contentKey(crypto.getRandomValues(new Uint8Array(32)), "session");

// A local store that keeps nothing, for tests that don't reload.
const NO_STORE: ChatReceiverOptions["store"] = { append: () => undefined };

// A session directory of its own: every test file shares the origin's OPFS.
async function session() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(`session-${crypto.randomUUID()}`, { create: true });
}

// A peer, known to others as `id`, with everything chat needs, asking `helpers` for repairs.
function peerState(id: string, helpers: () => string[], store = NO_STORE) {
  const clock = createClock(() => 1000);
  const log = createChatLog();
  const holdings = createChatHoldings();
  const asked: Array<[string, string, number]> = [];
  const repairs = createChatRepairs((peer, from, seq) => asked.push([peer, from, seq]));
  const receiver = createChatReceiver({
    content,
    clock,
    log,
    holdings,
    repairs,
    store,
    candidates: helpers,
  });
  return { id, clock, log, holdings, asked, receiver };
}

// An author whose published batches are kept in order, as its track would carry them.
async function author() {
  const peer = await generateKeyPair();
  const id = await keyId(peer.publicKey);
  const published: Array<{ key: string; bytes: Bytes }> = [];
  const sender = createChatSender({
    peer,
    content,
    clock: createClock(() => 5000),
    keep: () => undefined,
    publish: (key, bytes) => published.push({ key, bytes }),
  });

  // Writes each text and sends it as its own batch.
  async function say(...texts: string[]) {
    for (const t of texts) {
      await sender.write({ kind: "text", text: t }, 0);
      await sender.writable();
    }
  }

  return { id, published, say };
}

test("batches from the author's track reach the log and move the clock", async () => {
  const alice = await author();
  const bob = peerState("bob", () => []);
  await alice.say("one", "two");
  for (const { key, bytes } of alice.published) await bob.receiver.receive(key, bytes);
  expect(bob.log.entries().map((e) => e.text)).toEqual(["one", "two"]);
  expect(bob.clock.value() >= "000000001388").toBe(true);
  expect(bob.asked).toEqual([]);
});

test("a lost batch is asked for, and a repair from another peer's holdings fills it", async () => {
  const alice = await author();
  const carol = peerState("carol", () => []);
  const bob = peerState("bob", () => [carol.id]);
  await alice.say("one", "two", "three", "four");

  // Carol got everything; Bob lost the batches holding two and three.
  for (const { key, bytes } of alice.published) await carol.receiver.receive(key, bytes);
  const [one, , , four] = alice.published;
  await bob.receiver.receive(one!.key, one!.bytes);
  await bob.receiver.receive(four!.key, four!.bytes);
  expect(bob.asked).toEqual([[carol.id, alice.id, 2]]);

  const reply = carol.holdings.repair(alice.id, 2)!;
  const { key, bytes } = await sealBatch(content, reply);
  await bob.receiver.receive(key, bytes);
  expect(bob.log.entries().map((e) => e.text)).toEqual(["one", "two", "three", "four"]);
  expect(bob.log.versions()).toEqual({ [alice.id]: 4 });
});

test("a batch past an author's first message asks for the start, with none of theirs in order yet", async () => {
  const alice = await author();
  const carol = peerState("carol", () => []);
  const bob = peerState("bob", () => [carol.id]);
  await alice.say("one", "two");
  const [, two] = alice.published;
  await bob.receiver.receive(two!.key, two!.bytes);
  expect(bob.asked).toEqual([[carol.id, alice.id, 1]]);
  expect(bob.log.versions()).toEqual({ [alice.id]: 0 });
});

test("a repair that fills part of a gap asks again for the rest", async () => {
  const alice = await author();
  const carol = peerState("carol", () => []);
  const bob = peerState("bob", () => [carol.id]);
  await alice.say("one", "two", "three", "four");

  // Carol holds one and two only; Bob holds one and four.
  const [one, two, , four] = alice.published;
  for (const b of [one!, two!]) await carol.receiver.receive(b.key, b.bytes);
  for (const b of [one!, four!]) await bob.receiver.receive(b.key, b.bytes);

  const reply = carol.holdings.repair(alice.id, 2)!;
  const { key, bytes } = await sealBatch(content, reply);
  await bob.receiver.receive(key, bytes);
  expect(bob.asked.map(([, , seq]) => seq)).toEqual([2, 3]);
});

test("a repair reply that doesn't prove itself, or doesn't reach the gap, asks the next peer", async () => {
  const alice = await author();
  const bob = peerState("bob", () => ["carol", "dave"]);
  await alice.say("one", "two", "three");
  const [one, , three] = alice.published;
  for (const b of [one!, three!]) await bob.receiver.receive(b.key, b.bytes);
  const first = bob.asked[0]![0];
  const second = first === "carol" ? "dave" : "carol";

  const altered = one!.bytes.slice();
  altered[30] = (altered[30] ?? 0) ^ 1;
  await rejection(bob.receiver.receive(one!.key, altered, first));
  expect(bob.asked.map(([peer]) => peer)).toEqual([first, second]);

  // A reply holding only what Bob has: nobody is left to ask.
  await bob.receiver.receive(one!.key, one!.bytes, second);
  expect(bob.asked).toHaveLength(2);
});

test("after a reload, the store restores the log, the holdings and the clock", async () => {
  const alice = await author();
  await alice.say("one", "two", "three");
  const dir = await session();
  const store = await openChatStore(dir);
  const bob = peerState("bob", () => [], store);
  for (const { key, bytes } of alice.published) await bob.receiver.receive(key, bytes);
  await store.close();

  const reopened = await openChatStore(dir);
  const after = peerState("bob", () => [], reopened);
  await after.receiver.restore(reopened.records);
  expect(after.log.entries()).toEqual(bob.log.entries());
  expect(after.log.versions()).toEqual({ [alice.id]: 3 });
  expect(after.clock.value() >= bob.clock.value()).toBe(true);
  expect(after.holdings.repair(alice.id, 1)?.messages).toEqual(
    bob.holdings.repair(alice.id, 1)?.messages,
  );
  await reopened.close();
});

test("this peer's messages stored but never published go with its first batch after a reload", async () => {
  const peer = await generateKeyPair();
  const id = await keyId(peer.publicKey);
  const dir = await session();
  const store = await openChatStore(dir);
  const before = createChatSender({
    peer,
    content,
    clock: createClock(() => 5000),
    keep: (message) => store.append(id, { messages: [message] }),
    publish: () => undefined,
  });
  await before.write({ kind: "text", text: "never sent" }, 0);
  await store.close();

  const reopened = await openChatStore(dir);
  const { last, pending } = unsent(reopened.records.get(id)!);
  const published: string[] = [];
  const after = createChatSender({
    peer,
    content,
    clock: createClock(() => 6000),
    keep: (message) => reopened.append(id, { messages: [message] }),
    last,
    pending,
    publish: (key) => published.push(key),
  });
  await after.write({ kind: "text", text: "after" }, 0);
  await after.writable();
  expect(published).toEqual([`chat/${id}/1-2`]);
  await reopened.close();
});

test("a batch the store fails to take changes nothing, and is taken whole when it comes again", async () => {
  const alice = await author();
  await alice.say("one");
  const stored: number[] = [];
  const store: ChatReceiverOptions["store"] = {
    append: () => Promise.reject(new Error("the disk is full")),
  };
  const bob = peerState("bob", () => [], store);
  const { key, bytes } = alice.published[0]!;
  const error = await rejection(bob.receiver.receive(key, bytes));
  expect(error).toBeInstanceOf(Error);
  expect(bob.holdings.newest(alice.id)).toBe(0);
  expect(bob.log.entries()).toEqual([]);

  store.append = (_author, records) => stored.push(...(records.messages ?? []).map((m) => m.seq));
  await bob.receiver.receive(key, bytes);
  expect(stored).toEqual([1]);
  expect(bob.holdings.newest(alice.id)).toBe(1);
});

test("a batch that doesn't prove itself changes nothing", async () => {
  const alice = await author();
  const bob = peerState("bob", () => []);
  await alice.say("one");
  const { key, bytes } = alice.published[0]!;
  const altered = bytes.slice();
  altered[30] = (altered[30] ?? 0) ^ 1;
  const error = await rejection(bob.receiver.receive(key, altered));
  expect(error).toBeInstanceOf(Error);
  expect(bob.log.entries()).toEqual([]);
  expect(bob.holdings.newest(alice.id)).toBe(0);
});

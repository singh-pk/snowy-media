// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A peer's chat in one session (src/chat-session.ts), in Chromium, over links in memory: what a
// peer writes is shown at once and reaches others through its track; a gap is repaired over a
// link, moving on past a peer that answers chat-gone or whose link closes, and still over one
// link to a peer whose other link closed; a reconnecting peer catches up from one version
// vector, which moves on to the next peer if the first one's link closes; a batch that doesn't
// open changes nothing; after a reload, the log is back and unsent messages go with the first
// batch; and a chat closed with a batch on its way opens again, and takes no more messages.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { ChatClosedError, openChat } from "../src/chat-session";
import { contentKey, generateKeyPair, type Bytes } from "../src/crypto";
import { rank } from "../src/rank";
import { createNetwork } from "./support/memory-link";
import { rejection } from "./support/rejection";

const content = await contentKey(crypto.getRandomValues(new Uint8Array(32)), "session");

// A session directory of its own: every test file shares the origin's OPFS.
async function session() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(`session-${crypto.randomUUID()}`, { create: true });
}

// A new peer's chat, in a session directory of its own.
async function member() {
  const pair = await generateKeyPair();
  const directory = await session();
  return reopen(pair, directory);
}

// A peer's chat, opened from its session directory, with what it publishes on its track.
async function reopen(pair: CryptoKeyPair, directory: FileSystemDirectoryHandle) {
  const published: Array<{ key: string; bytes: Bytes }> = [];
  const listeners: Array<() => void> = [];
  const chat = await openChat({
    peer: pair,
    content,
    session: directory,
    publish: (key, bytes) => published.push({ key, bytes }),
    onChange: () => {
      for (const listener of listeners) listener();
    },
  });
  const onChange = (listener: () => void) => void listeners.push(listener);
  return { chat, published, pair, directory, onChange };
}

type Member = Awaited<ReturnType<typeof member>>;

const texts = ({ chat }: Member) => chat.entries().map((e) => e.text);

// Writes each text as one batch on the author's track.
async function say(author: Member, ...lines: string[]) {
  for (const text of lines) {
    await author.chat.write({ kind: "text", text }, 0);
    await author.chat.writable();
  }
}

// Waits for `work`, whether it resolves or rejects.
async function quietly(work: Promise<unknown>) {
  try {
    await work;
  } catch {
    // Either way is fine here.
  }
}

// Joins two members with a link in memory.
function join(network: ReturnType<typeof createNetwork>, a: Member, b: Member) {
  const [fromA, fromB] = network.pair(a.chat.id, b.chat.id);
  a.chat.connect(fromA);
  b.chat.connect(fromB);
  return fromA;
}

// Alice says `lines`, which Carol and Dave hold; Bob, who holds none, is linked to both.
async function twoHolders(...lines: string[]) {
  const network = createNetwork();
  const [alice, bob, carol, dave] = await Promise.all([member(), member(), member(), member()]);
  await say(alice, ...lines);

  for (const holder of [carol, dave]) {
    for (const { key, bytes } of alice.published) await holder.chat.received(key, bytes);
  }

  const toCarol = join(network, bob, carol);
  const toDave = join(network, bob, dave);
  return { network, alice, bob, carol, dave, toCarol, toDave };
}

test("a message is shown at once, and reaches others through the author's track", async () => {
  const alice = await member();
  const bob = await member();
  const changes = { alice: 0, bob: 0 };
  alice.onChange(() => changes.alice++);
  bob.onChange(() => changes.bob++);
  await alice.chat.write({ kind: "text", text: "hi" }, 0);
  expect(texts(alice)).toEqual(["hi"]);
  expect(alice.published).toHaveLength(0);

  await alice.chat.writable();
  for (const { key, bytes } of alice.published) await bob.chat.received(key, bytes);
  expect(texts(bob)).toEqual(["hi"]);
  // Alice's change on writing, and on taking her own batch back; Bob's on taking it.
  expect(changes).toEqual({ alice: 2, bob: 1 });
  await Promise.all([alice.chat.close(), bob.chat.close()]);
});

test("a gap is repaired over a link from a peer that holds it", async () => {
  const network = createNetwork();
  const [alice, bob, carol] = await Promise.all([member(), member(), member()]);
  await say(alice, "one", "two", "three");
  for (const { key, bytes } of alice.published) await carol.chat.received(key, bytes);
  join(network, bob, carol);

  const [one, , three] = alice.published;
  await bob.chat.received(one!.key, one!.bytes);
  await bob.chat.received(three!.key, three!.bytes);
  await network.settle();
  expect(texts(bob)).toEqual(["one", "two", "three"]);
  await Promise.all([alice, bob, carol].map((m) => m.chat.close()));
});

test("an ask moves to the next peer when its link closes", async () => {
  const { network, alice, bob, carol, dave, toCarol, toDave } = await twoHolders(
    "one",
    "two",
    "three",
  );
  const [first] = await rank([carol.chat.id, dave.chat.id], alice.chat.id, 2);
  const [one, , three] = alice.published;
  await bob.chat.received(one!.key, one!.bytes);
  await bob.chat.received(three!.key, three!.bytes);
  // The ask is on its way to the first-ranked peer; its link closes before it arrives.
  (first === carol.chat.id ? toCarol : toDave).close();
  await network.settle();
  expect(texts(bob)).toEqual(["one", "two", "three"]);
  await Promise.all([alice, bob, carol, dave].map((m) => m.chat.close()));
});

test("a reconnecting peer catches up from one version vector", async () => {
  const network = createNetwork();
  const [alice, bob, carol] = await Promise.all([member(), member(), member()]);
  await say(alice, "one", "two");
  await say(carol, "three");
  for (const { key, bytes } of alice.published) await carol.chat.received(key, bytes);
  await bob.chat.received(alice.published[0]!.key, alice.published[0]!.bytes);

  join(network, bob, carol);
  await bob.chat.reconnected();
  await network.settle();
  expect(texts(bob).toSorted()).toEqual(["one", "three", "two"]);
  await Promise.all([alice, bob, carol].map((m) => m.chat.close()));
});

test("the version vector moves to the next peer when the first one's link closes before it answers", async () => {
  const { network, alice, bob, carol, dave, toCarol, toDave } = await twoHolders("one", "two");
  // Ranked as `reconnected` ranks: closing the other link would let the first peer answer, and the
  // test would pass without the vector moving on.
  const [first] = await rank([carol.chat.id, dave.chat.id], bob.chat.id, "chat-versions");
  await bob.chat.reconnected();
  // The vector is on its way to the first-ranked peer; its link closes before it arrives.
  (first === carol.chat.id ? toCarol : toDave).close();
  await network.settle();
  expect(texts(bob)).toEqual(["one", "two"]);
  await Promise.all([alice, bob, carol, dave].map((m) => m.chat.close()));
});

test("a batch that doesn't open changes nothing", async () => {
  const [alice, bob] = await Promise.all([member(), member()]);
  await say(alice, "one");
  const changes = { count: 0 };
  // A batch taken, even one adding nothing, reports a change; a refused one doesn't.
  bob.onChange(() => changes.count++);
  await bob.chat.received(alice.published[0]!.key, new Uint8Array([1, 2, 3]));
  expect(texts(bob)).toEqual([]);
  expect(changes.count).toBe(0);
  await Promise.all([alice, bob].map((m) => m.chat.close()));
});

test("after a reload the log is back, and unsent messages go with the first batch", async () => {
  const alice = await member();
  await say(alice, "one");
  alice.chat.unwritable();
  await alice.chat.write({ kind: "text", text: "two" }, 0);
  await alice.chat.close();

  const again = await reopen(alice.pair, alice.directory);
  expect(texts(again)).toEqual(["one", "two"]);
  await again.chat.writable();
  const bob = await member();
  await bob.chat.received(alice.published[0]!.key, alice.published[0]!.bytes);
  for (const { key, bytes } of again.published) await bob.chat.received(key, bytes);
  expect(texts(bob)).toEqual(["one", "two"]);
  await Promise.all([again.chat.close(), bob.chat.close()]);
});

test("an ask moves past a peer that answers chat-gone", async () => {
  const network = createNetwork();
  const [alice, bob, carol, dave] = await Promise.all([member(), member(), member(), member()]);
  await say(alice, "one", "two", "three");
  const [first, second] = await rank([carol.chat.id, dave.chat.id], alice.chat.id, 2);
  const holder = second === carol.chat.id ? carol : dave;
  for (const { key, bytes } of alice.published) await holder.chat.received(key, bytes);
  expect(first).not.toBe(holder.chat.id);
  join(network, bob, carol);
  join(network, bob, dave);

  const [one, , three] = alice.published;
  await bob.chat.received(one!.key, one!.bytes);
  await bob.chat.received(three!.key, three!.bytes);
  await network.settle();
  expect(texts(bob)).toEqual(["one", "two", "three"]);
  await Promise.all([alice, bob, carol, dave].map((m) => m.chat.close()));
});

test("with two links to a peer, one closing leaves the other carrying asks and replies", async () => {
  const network = createNetwork();
  const [alice, bob, carol] = await Promise.all([member(), member(), member()]);
  await say(alice, "one", "two", "three", "four");
  join(network, bob, carol);
  join(network, bob, carol).close();
  await network.settle();

  // Carol misses two, which Bob holds; then Bob misses three, which Carol holds.
  const [one, two, three, four] = alice.published;
  for (const b of [one!, two!]) await bob.chat.received(b.key, b.bytes);
  for (const b of [one!, three!]) await carol.chat.received(b.key, b.bytes);
  await network.settle();
  await bob.chat.received(four!.key, four!.bytes);
  await network.settle();
  expect(texts(bob)).toEqual(["one", "two", "three", "four"]);
  expect(texts(carol)).toEqual(["one", "two", "three"]);
  await Promise.all([alice, bob, carol].map((m) => m.chat.close()));
});

test("a closed chat takes no more messages, and one closed mid-batch opens again unsent", async () => {
  const alice = await member();
  await alice.chat.write({ kind: "text", text: "hi" }, 0);
  const sending = quietly(alice.chat.writable());
  await alice.chat.close();
  await sending;
  const error = await rejection(alice.chat.write({ kind: "text", text: "late" }, 0));
  expect(error).toBeInstanceOf(ChatClosedError);

  const again = await reopen(alice.pair, alice.directory);
  expect(texts(again)).toEqual(["hi"]);
  await again.chat.writable();
  const bob = await member();

  for (const { key, bytes } of [...alice.published, ...again.published]) {
    await bob.chat.received(key, bytes);
  }

  expect(texts(bob)).toEqual(["hi"]);
  await Promise.all([again.chat.close(), bob.chat.close()]);
});

test("an object that isn't chat, from the peer sent the version vector, doesn't end the catch-up", async () => {
  const network = createNetwork();
  const [alice, bob, x, y] = await Promise.all([member(), member(), member(), member()]);
  await say(alice, "one", "two");
  const [firstId] = await rank([x.chat.id, y.chat.id], bob.chat.id, "chat-versions");
  // The first-ranked peer holds nothing, so only the next one can catch Bob up.
  const [first, second] = firstId === x.chat.id ? [x, y] : [y, x];
  for (const { key, bytes } of alice.published) await second.chat.received(key, bytes);
  const fromFirst = join(network, first, bob);
  join(network, second, bob);
  await bob.chat.reconnected();
  // A link carries the watch session's objects too: one of those leaves the vector waiting.
  fromFirst.deliver("catalog@1", alice.published[0]!.bytes);
  await network.settle();
  expect(texts(bob)).toEqual([]);

  fromFirst.close();
  await network.settle();
  expect(texts(bob)).toEqual(["one", "two"]);
  await Promise.all([alice, bob, x, y].map((m) => m.chat.close()));
});

test("a batch that comes after close changes nothing", async () => {
  const [alice, bob] = await Promise.all([member(), member()]);
  await say(alice, "one");
  await bob.chat.close();
  await bob.chat.received(alice.published[0]!.key, alice.published[0]!.bytes);
  expect(texts(bob)).toEqual([]);
  await alice.chat.close();
});

test("a reconnect with no peer linked sends no version vector, then or once one links", async () => {
  const network = createNetwork();
  const [alice, bob, carol] = await Promise.all([member(), member(), member()]);
  await say(alice, "one");
  for (const { key, bytes } of alice.published) await carol.chat.received(key, bytes);
  await bob.chat.reconnected();
  join(network, bob, carol);
  await network.settle();
  expect(texts(bob)).toEqual([]);
  await Promise.all([alice, bob, carol].map((m) => m.chat.close()));
});

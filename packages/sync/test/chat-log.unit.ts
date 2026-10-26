// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The chat log (src/chat-log.ts), in Chromium: every peer shows the same order whatever order
// messages arrive in; a late message is marked; gaps and version vectors follow the seqs held;
// and edits, deletes and reactions follow the rules in docs/architecture.md#edits-deletes-and-reactions.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { createChatLog } from "../src/chat-log";
import { createClock } from "../src/hlc";
import { createAuthor } from "./support/chat";

// Wall clocks the tests move; each author has its own.
const wall = { alice: 1000, bob: 1000 };
// The clock of a peer that hasn't sent or received anything: nothing it adds is late.
const ZERO = "0000000000000000";

async function authors() {
  const alice = await createAuthor(() => wall.alice);
  const bob = await createAuthor(() => wall.bob);
  return { alice, bob };
}

const texts = (log: ReturnType<typeof createChatLog>) => log.entries().map((e) => e.text);

test("every peer shows the same order, whatever order messages arrive in", async () => {
  const { alice, bob } = await authors();
  const a1 = await alice.write({ kind: "text", text: "a1" });
  bob.clock.receive(a1.hlc);
  const b1 = await bob.write({ kind: "text", text: "b1" });
  alice.clock.receive(b1.hlc);
  const a2 = await alice.write({ kind: "text", text: "a2" });

  const inOrder = createChatLog();
  const reversed = createChatLog();
  for (const m of [a1, b1, a2]) inOrder.add(m, ZERO);
  for (const m of [a2, b1, a1]) reversed.add(m, ZERO);
  expect(texts(inOrder)).toEqual(["a1", "b1", "a2"]);
  expect(texts(reversed)).toEqual(["a1", "b1", "a2"]);
});

test("messages with the same clock value sort by author", async () => {
  const { alice, bob } = await authors();
  const a = await alice.write({ kind: "text", text: "a" });
  const b = await bob.write({ kind: "text", text: "b" });
  expect(a.hlc).toBe(b.hlc);

  // Both arrival orders, so the comparison is made each way round whichever key sorts first.
  const inOrder = createChatLog();
  const reversed = createChatLog();
  for (const m of [a, b]) inOrder.add(m, ZERO);
  for (const m of [b, a]) reversed.add(m, ZERO);
  const byAuthor = alice.id < bob.id ? ["a", "b"] : ["b", "a"];
  expect(texts(inOrder)).toEqual(byAuthor);
  expect(texts(reversed)).toEqual(byAuthor);
});

test("one author's messages with the same clock value, as a faulty clock would give, sort by seq", async () => {
  const { alice } = await authors();
  const first = await alice.write({ kind: "text", text: "first" });
  const written = await alice.write({ kind: "text", text: "second" });
  const second = { ...written, hlc: first.hlc };

  const inOrder = createChatLog();
  const reversed = createChatLog();
  for (const m of [first, second]) inOrder.add(m, ZERO);
  for (const m of [second, first]) reversed.add(m, ZERO);
  expect(texts(inOrder)).toEqual(["first", "second"]);
  expect(texts(reversed)).toEqual(["first", "second"]);
});

test("a message that sorts below the peer's clock when it arrives is marked late", async () => {
  const { alice, bob } = await authors();
  const offline = await alice.write({ kind: "text", text: "written offline" });
  wall.bob = 5000;
  const later = await bob.write({ kind: "text", text: "later" });
  wall.bob = 1000;

  const peer = createClock(() => 5000);
  const log = createChatLog();
  log.add(later, peer.value());
  peer.receive(later.hlc);
  log.add(offline, peer.value());
  peer.receive(offline.hlc);
  expect(log.entries().map((e) => [e.text, e.late])).toEqual([
    ["written offline", true],
    ["later", false],
  ]);
});

test("a message from far in the future doesn't make the ones after it late", async () => {
  const { alice, bob } = await authors();
  wall.bob = 10_000_000;
  const future = await bob.write({ kind: "text", text: "from the future" });
  wall.bob = 1000;

  const peer = createClock(() => 1000);
  const log = createChatLog();
  log.add(future, peer.value());
  peer.receive(future.hlc);
  const now = await alice.write({ kind: "text", text: "now" });
  log.add(now, peer.value());
  expect(log.entries().map((e) => [e.text, e.late])).toEqual([
    ["now", false],
    ["from the future", false],
  ]);
});

test("a gap is the seqs between the author's newest message and one that skips ahead", async () => {
  const { alice } = await authors();
  const sent = [];

  for (let i = 1; i <= 5; i++) {
    const message = await alice.write({ kind: "text", text: String(i) });
    sent.push(message);
  }

  const [m1, m2, m3, m4, m5] = sent;

  const log = createChatLog();
  expect(log.add(m1!, ZERO)).toEqual({ added: true });
  expect(log.add(m4!, ZERO)).toEqual({
    added: true,
    gap: { author: alice.id, firstSeq: 2, lastSeq: 3 },
  });
  expect(log.versions()).toEqual({ [alice.id]: 1 });

  // Repair fills the gap without reporting one; a seq already held is ignored.
  expect(log.add(m3!, ZERO)).toEqual({ added: true });
  expect(log.add(m2!, ZERO)).toEqual({ added: true });
  expect(log.add(m2!, ZERO)).toEqual({ added: false });
  expect(log.versions()).toEqual({ [alice.id]: 4 });
  expect(log.add(m5!, ZERO)).toEqual({ added: true });
  expect(log.versions()).toEqual({ [alice.id]: 5 });
});

test("the latest edit by its author wins, and a delete hides the message and its edits", async () => {
  const { alice, bob } = await authors();
  const original = await alice.write({ kind: "text", text: "see you at 9" });
  const target = { author: alice.id, seq: original.seq };
  const first = await alice.write({ kind: "edit", target, text: "see you at 10" });
  const second = await alice.write({ kind: "edit", target, text: "see you at 10!" });
  const notTheirs = await bob.write({ kind: "edit", target, text: "hacked" });
  const bobsDelete = await bob.write({ kind: "delete", target });

  const log = createChatLog();
  for (const m of [second, original, notTheirs, first, bobsDelete]) log.add(m, ZERO);
  expect(log.entries().map((e) => [e.text, e.edited])).toEqual([["see you at 10!", true]]);

  const alicesDelete = await alice.write({ kind: "delete", target });
  log.add(alicesDelete, ZERO);
  expect(log.entries()).toEqual([]);
});

test("reactions are kept per reactor and emoji, and the latest message for each wins", async () => {
  // One wall clock that ticks on every read, so the messages sort in the order written.
  const tick = { ms: 0 };
  const now = () => ++tick.ms;
  const alice = await createAuthor(now);
  const bob = await createAuthor(now);
  const message = await alice.write({ kind: "text", text: "the twist!" });
  const target = { author: alice.id, seq: message.seq };

  const bobWows = await bob.write({ kind: "react", target, emoji: "😮" });
  const aliceWows = await alice.write({ kind: "react", target, emoji: "😮" });
  const bobEats = await bob.write({ kind: "react", target, emoji: "🍿" });
  const bobWowsAgain = await bob.write({ kind: "react", target, emoji: "😮" });
  const removal = await bob.write({ kind: "react", target, emoji: "😮", text: "" });

  const log = createChatLog();
  for (const m of [message, bobWows, aliceWows, bobEats, bobWowsAgain]) log.add(m, ZERO);
  expect(log.entries()[0]!.reactions).toEqual([
    { emoji: "😮", peers: [alice.id, bob.id] },
    { emoji: "🍿", peers: [bob.id] },
  ]);

  log.add(removal, ZERO);
  expect(log.entries()[0]!.reactions).toEqual([
    { emoji: "😮", peers: [alice.id] },
    { emoji: "🍿", peers: [bob.id] },
  ]);
});

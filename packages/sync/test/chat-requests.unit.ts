// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Chat repair messages (src/chat-requests.ts), in Chromium: only well-formed messages pass the
// check; peers wired by their messages, round-tripped through JSON as a link carries them, fill
// a gap from a responder's holdings, move on to the next peer on `chat-gone`, and catch up on
// reconnect from one version vector.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { createChatHoldings } from "../src/chat-holdings";
import { createChatLog } from "../src/chat-log";
import { createChatReceiver } from "../src/chat-receiver";
import { createChatRepairs } from "../src/chat-repairs";
import { checkChatControl, createChatResponder, type ChatControl } from "../src/chat-requests";
import { createChatSender } from "../src/chat-sender";
import { contentKey, generateKeyPair, keyId, type Bytes } from "../src/crypto";
import { createClock } from "../src/hlc";
import { rank } from "../src/rank";

const content = await contentKey(crypto.getRandomValues(new Uint8Array(32)), "session");
const alice = await generateKeyPair();
const aliceId = await keyId(alice.publicKey);

// What Alice published, in order, as her track carried it.
const published: Array<{ key: string; bytes: Bytes }> = [];
const sender = createChatSender({
  peer: alice,
  content,
  clock: createClock(() => 5000),
  keep: () => undefined,
  publish: (key, bytes) => published.push({ key, bytes }),
});

for (const text of ["one", "two", "three", "four"]) {
  await sender.write({ kind: "text", text }, 0);
  await sender.writable();
}

// How a peer reaches another: its messages, and the objects it delivers.
type Reachable = {
  handle(from: string, message: ChatControl): Promise<void>;
  receive(key: string, bytes: Bytes, from: string): Promise<void>;
};

// The peers of one test, and every hop still in flight, so a test can wait for them all.
function network() {
  const peers = new Map<string, Reachable>();
  const hops: Array<Promise<unknown>> = [];

  function hop(work: Promise<unknown>) {
    hops.push(work);
  }

  // Waits until every hop, and every hop it started, has arrived.
  async function settle() {
    while (hops.length > 0) await Promise.all(hops.splice(0));
  }

  return { peers, hop, settle };
}

type Network = ReturnType<typeof network>;

// A peer by name, asking `candidates` for repairs. Its messages go to the peer they name, as
// JSON; objects it delivers go to that peer's receiver, as a reply from this one.
function peer(id: string, candidates: string[], { peers, hop }: Network) {
  const holdings = createChatHoldings();
  const log = createChatLog();
  const asked: Array<[string, number]> = [];

  function send(to: string, message: ChatControl) {
    const value: unknown = JSON.parse(JSON.stringify(message));
    const checked = checkChatControl(value)!;
    hop(peers.get(to)!.handle(id, checked));
  }

  const repairs = createChatRepairs((to, author, firstSeq) => {
    asked.push([to, firstSeq]);
    send(to, { type: "chat-request", author, firstSeq });
  });
  const receiver = createChatReceiver({
    content,
    clock: createClock(() => 1000),
    log,
    holdings,
    repairs,
    store: { append: () => undefined },
    candidates: () => candidates,
  });
  const responder = createChatResponder({
    content,
    holdings,
    send,
    deliver: (to, key, bytes) => hop(peers.get(to)!.receive(key, bytes, id)),
  });

  // A message from `from`: a request to answer, or a `chat-gone` for an ask of this peer's.
  async function handle(from: string, message: ChatControl) {
    if (message.type === "chat-gone") repairs.gone(from, message.author, message.firstSeq);
    else await responder.requested(from, message);
  }

  peers.set(id, { handle, receive: receiver.receive });
  return { id, log, asked, receiver, send };
}

const texts = (p: ReturnType<typeof peer>) => p.log.entries().map((e) => e.text);

test("only well-formed chat messages pass the check", () => {
  const good = [
    { type: "chat-request", author: aliceId, firstSeq: 3 },
    { type: "chat-gone", author: aliceId, firstSeq: 1 },
    { type: "chat-versions", versions: { [aliceId]: 0 } },
    { type: "chat-versions", versions: {} },
  ];
  for (const value of good) expect(checkChatControl(value)).toEqual(value);

  const bad = [
    null,
    "chat-request",
    { type: "chat-request", author: "alice", firstSeq: 3 },
    { type: "chat-request", author: aliceId, firstSeq: 0 },
    { type: "chat-request", author: aliceId, firstSeq: 1.5 },
    { type: "chat-request", author: aliceId, firstSeq: "3" },
    { type: "chat-gone", author: aliceId },
    { type: "chat-versions", versions: { alice: 1 } },
    { type: "chat-versions", versions: { [aliceId]: -1 } },
    { type: "chat-versions", versions: [] },
    { type: "request", key: "media/0/1" },
  ];
  for (const value of bad) expect(checkChatControl(value)).toBeUndefined();
});

test("a request is answered from the responder's holdings, and fills the gap", async () => {
  const net = network();
  const carol = peer("carol", [], net);
  const bob = peer("bob", ["carol"], net);
  for (const { key, bytes } of published) await carol.receiver.receive(key, bytes);

  const [one, , , four] = published;
  await bob.receiver.receive(one!.key, one!.bytes);
  await bob.receiver.receive(four!.key, four!.bytes);
  await net.settle();
  expect(bob.asked).toEqual([["carol", 2]]);
  expect(texts(bob)).toEqual(["one", "two", "three", "four"]);
});

test("chat-gone moves the ask to the next peer", async () => {
  const net = network();
  // The peer Bob asks first holds nothing and answers chat-gone; the next one fills the gap.
  const [first, second] = await rank(["carol", "dave"], aliceId, 2);
  peer(first!, [], net);
  const holder = peer(second!, [], net);
  const bob = peer("bob", ["carol", "dave"], net);
  for (const { key, bytes } of published) await holder.receiver.receive(key, bytes);

  const [one, , , four] = published;
  await bob.receiver.receive(one!.key, one!.bytes);
  await bob.receiver.receive(four!.key, four!.bytes);
  await net.settle();
  expect(bob.asked).toEqual([
    [first, 2],
    [second, 2],
  ]);
  expect(texts(bob)).toEqual(["one", "two", "three", "four"]);
});

test("one version vector on reconnect brings everything beyond it", async () => {
  const net = network();
  const carol = peer("carol", [], net);
  const bob = peer("bob", ["carol"], net);
  for (const { key, bytes } of published) await carol.receiver.receive(key, bytes);
  await bob.receiver.receive(published[0]!.key, published[0]!.bytes);

  bob.send("carol", { type: "chat-versions", versions: bob.log.versions() });
  await net.settle();
  expect(texts(bob)).toEqual(["one", "two", "three", "four"]);
  expect(bob.asked).toEqual([]);
});

test("a held reply that no longer seals is answered with chat-gone, and left out of a version reply", async () => {
  const holdings = createChatHoldings();
  // No messages: what sealing refuses, as it would a stored message that no longer checks.
  const unsealable = { messages: [], checkpoint: { author: aliceId, seq: 1, head: "", sig: "" } };
  const sent: unknown[] = [];
  const delivered: string[] = [];
  const responder = createChatResponder({
    content,
    holdings: { ...holdings, repair: () => unsealable, after: () => [unsealable] },
    send: (to, message) => sent.push([to, message]),
    deliver: (_, key) => delivered.push(key),
  });
  await responder.requested("bob", { type: "chat-request", author: aliceId, firstSeq: 1 });
  await responder.requested("bob", { type: "chat-versions", versions: {} });
  expect(sent).toEqual([["bob", { type: "chat-gone", author: aliceId, firstSeq: 1 }]]);
  expect(delivered).toEqual([]);
});

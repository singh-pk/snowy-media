// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Getting the session's state on join (src/state-requests.ts), in Chromium, over links in memory:
// a joiner asks the source first when it's online, otherwise peers by rank, moving on when a peer
// answers `state-gone`, delivers a record that doesn't check out, delivers too little, or closes
// its link; it takes the chunk index with the rest; a peer that comes online during an ask is
// asked in its turn; it asks no more once it holds the whole state, however the records came; and
// an ask that runs out of peers can start again.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import type { Catalog } from "../src/catalog";
import { contentKey, generateKeyPair, keyId, type KeyId } from "../src/crypto";
import type { Link } from "../src/link";
import { rank } from "../src/rank";
import { InvalidRecordError } from "../src/signed-record";
import { createSourceRecords, sealSourceRecord, type SourceRecord } from "../src/source-records";
import { checkStateControl, createStateAsk, createStateResponder } from "../src/state-requests";
import { createNetwork } from "./support/memory-link";

const session = await generateKeyPair();
const sessionId = await keyId(session.publicKey);
const content = await contentKey(crypto.getRandomValues(new Uint8Array(32)), sessionId);

const catalog: Catalog = {
  version: 1,
  durationUs: 60_000_000,
  tracks: [
    { id: 0, kind: "video", codec: "vp09.00.10.08", bitrateKbps: 900 },
    { id: 1, kind: "audio", codec: "opus", bitrateKbps: 96 },
  ],
};
const state: SourceRecord[] = [
  { kind: "catalog", catalog },
  { kind: "control", control: { epoch: 4, playing: true, mediaUs: 0, atUs: 9, ended: false } },
  { kind: "setup", setup: { track: 0, codec: "vp09.00.10.08", codedWidth: 64, codedHeight: 48 } },
  { kind: "setup", setup: { track: 1, codec: "opus", sampleRate: 48_000, numberOfChannels: 2 } },
];
const objects = await Promise.all(
  state.map(async (record) => sealSourceRecord(session, content, record)),
);

const newRecords = () => createSourceRecords({ sessionKey: session.publicKey, content });

// Records holding the first `held` of the state's, for peers that answer from them.
async function holding(held: number) {
  const records = newRecords();
  for (const object of objects.slice(0, held)) await records.receive(object);
  return records;
}

const whole = await holding(4);
// The catalog, the control record and one setup: not the whole state.
const part = await holding(3);

// A peer the joiner can ask: it answers state requests from its records, or as `respond` does,
// given its end of the link and the request's number.
type Peer = {
  id: KeyId;
  records?: ReturnType<typeof newRecords>;
  respond?: (link: Link, ask: number) => void;
};

// A joiner and the peers it can ask, each joined to it by a link. `asked` lists every peer
// asked, in order, and `rejected` what the joiner refused.
async function joining(peers: Peer[]) {
  const network = createNetwork();
  const joinerPair = await generateKeyPair();
  const joiner = await keyId(joinerPair.publicKey);
  const records = newRecords();
  const links = new Map<KeyId, Link>();
  const open = new Set<KeyId>();
  const asked: KeyId[] = [];
  const rejected: unknown[] = [];
  const ask = createStateAsk({
    records,
    send: (peer, message) => {
      asked.push(peer);
      links.get(peer)?.send(message);
    },
    linked: (peer) => open.has(peer),
  });

  for (const peer of peers) {
    const [mine, theirs] = network.pair(joiner, peer.id);
    links.set(peer.id, mine);
    open.add(peer.id);
    const responder = createStateResponder({
      records: peer.records ?? newRecords(),
      send: (_, message) => theirs.send(message),
      deliver: (_, key, bytes) => theirs.deliver(key, bytes),
    });

    theirs.on("message", (value) => {
      const message = checkStateControl(value);
      if (message?.type !== "state-request") return;
      if (peer.respond === undefined) responder.requested(joiner, message);
      else peer.respond(theirs, message.ask);
    });

    mine.on("message", (value) => {
      const message = checkStateControl(value);
      if (message !== undefined && message.type !== "state-request") ask.answered(peer.id, message);
    });

    mine.on("object", async (key, bytes) => {
      try {
        await ask.delivered(peer.id, key, bytes);
      } catch (error) {
        rejected.push(error);
      }
    });

    mine.on("close", () => {
      open.delete(peer.id);
      ask.closed(peer.id);
    });
  }

  // Closes a peer's link as a transport would: this end no longer counts it open at once.
  function close(peer: KeyId) {
    open.delete(peer);
    links.get(peer)?.close();
  }

  return { network, records, links, ask, asked, rejected, close };
}

const ids = async (count: number): Promise<KeyId[]> =>
  Promise.all(
    Array.from({ length: count }, async () => {
      const pair = await generateKeyPair();
      return keyId(pair.publicKey);
    }),
  );

// A peer that answers nothing until the test does, through `gone`.
function holdingBack() {
  const held: { link?: Link; ask?: number } = {};

  function respond(link: Link, ask: number) {
    held.link = link;
    held.ask = ask;
  }

  const gone = () => held.link?.send({ type: "state-gone", ask: held.ask ?? 0 });
  return { respond, gone };
}

test("a joiner asks the source first when it's online, and no one else", async () => {
  const [source = "", a = "", b = ""] = await ids(3);
  const j = await joining([a, b, source].map((id) => ({ id, records: whole })));
  await j.ask.start([a, b, source], source);
  await j.network.settle();
  expect(j.asked).toEqual([source]);
  expect(j.records.complete()).toBe(true);
  expect(j.records.objects()).toEqual(objects);
});

test("a joiner takes the chunk index with the rest of the state", async () => {
  const [source = ""] = await ids(1);
  const indexed = await holding(4);
  const page = await sealSourceRecord(session, content, {
    kind: "index",
    page: { page: 0, bounds: [0, 2_000_000, 4_500_000], bytes: [3_100_000, 4_200_000] },
  });
  await indexed.receive(page);
  const j = await joining([{ id: source, records: indexed }]);
  await j.ask.start([source], source);
  await j.network.settle();
  expect(j.records.index()).toEqual({
    bounds: [0, 2_000_000, 4_500_000],
    bytes: [3_100_000, 4_200_000],
  });
  expect(j.records.objects()).toEqual([...objects, page]);
});

test("without the source, a joiner asks peers by rank, past those that don't hold the whole state", async () => {
  const candidates = await ids(3);
  const ranked = await rank(candidates, "state");
  // The two best-ranked hold only part of the state, so they answer state-gone.
  const j = await joining(ranked.map((id, i) => ({ id, records: i < 2 ? part : whole })));
  await j.ask.start(candidates);
  await j.network.settle();
  expect(j.asked).toEqual(ranked);
  expect(j.records.complete()).toBe(true);
});

test("a joiner moves on when the asked peer's link closes, it delivers a forged record, or too little", async () => {
  const candidates = await ids(4);
  const [first = "", second = "", third = "", fourth = ""] = await rank(candidates, "state");
  const forger = await generateKeyPair();
  const forged = await sealSourceRecord(forger, content, { kind: "catalog", catalog });
  const [catalogObject] = objects;
  const j = await joining([
    { id: first, respond: (link) => link.close() },
    { id: second, respond: (link) => link.deliver(forged.key, forged.sealed) },
    {
      id: third,
      respond: (link, ask) => {
        if (catalogObject !== undefined) link.deliver(catalogObject.key, catalogObject.sealed);
        link.send({ type: "state-sent", ask, count: 1 });
      },
    },
    { id: fourth, records: whole },
  ]);
  await j.ask.start(candidates);
  await j.network.settle();
  expect(j.asked).toEqual([first, second, third, fourth]);
  expect(j.rejected).toEqual([new InvalidRecordError("bad signature")]);
  expect(j.records.complete()).toBe(true);
});

test("a peer whose link closes while the joiner ranks isn't asked", async () => {
  const candidates = await ids(2);
  const [first = "", second = ""] = await rank(candidates, "state");
  const j = await joining([
    { id: first, records: whole },
    { id: second, records: whole },
  ]);
  const starting = j.ask.start(candidates);
  j.close(first);
  await starting;
  await j.network.settle();
  expect(j.asked).toEqual([second]);
  expect(j.records.complete()).toBe(true);
});

test("an ask started again while the first still ranks replaces it, so one peer is asked", async () => {
  const candidates = await ids(3);
  const [first = "", second = ""] = await rank(candidates, "state");
  const j = await joining(candidates.map((id) => ({ id, records: whole })));
  // Not the first-ranked peer, so asking it would show.
  const superseded = j.ask.start([second]);
  await j.ask.start(candidates);
  await superseded;
  await j.network.settle();
  expect(j.asked).toEqual([first]);
  expect(j.records.complete()).toBe(true);
});

test("the source coming online during an ask is asked next", async () => {
  const [a = "", b = "", source = ""] = await ids(3);
  const [firstOfTwo = "", secondOfTwo = ""] = await rank([a, b], "state");
  const held = holdingBack();
  const j = await joining([
    { id: firstOfTwo, respond: held.respond },
    { id: secondOfTwo, records: whole },
    { id: source, records: whole },
  ]);
  await j.ask.start([a, b]);
  await j.network.settle();
  await j.ask.start([a, b, source], source);
  held.gone();
  await j.network.settle();
  expect(j.asked).toEqual([firstOfTwo, source]);
  expect(j.records.complete()).toBe(true);
});

test("a joiner that comes to hold the state another way asks no more", async () => {
  const candidates = await ids(2);
  const [first = ""] = await rank(candidates, "state");
  const held = holdingBack();
  const j = await joining(candidates.map((id) => ({ id, records: whole, respond: held.respond })));
  await j.ask.start(candidates);
  await j.network.settle();
  // The records come from the source's tracks meanwhile; then the asked peer answers.
  for (const object of objects) await j.records.receive(object);
  held.gone();
  await j.network.settle();
  expect(j.asked).toEqual([first]);
  await j.ask.start(candidates);
  expect(j.asked).toEqual([first]);
});

test("an answer from a peer not asked, or to an earlier request, is ignored", async () => {
  const [peer = "", other = ""] = await ids(2);
  const held = holdingBack();
  const j = await joining([
    { id: peer, respond: held.respond },
    { id: other, records: whole },
  ]);
  // The first request runs out of peers; the second asks the same peer again.
  await j.ask.start([peer]);
  await j.network.settle();
  held.gone();
  await j.network.settle();
  await j.ask.start([peer]);
  await j.network.settle();
  j.ask.answered(other, { type: "state-gone", ask: 2 });
  j.ask.answered(peer, { type: "state-gone", ask: 1 });
  await j.network.settle();
  expect(j.asked).toEqual([peer, peer]);

  // The answer to the second request is taken: the ask runs out of peers, and asks no one else.
  held.gone();
  await j.network.settle();
  expect(j.asked).toEqual([peer, peer]);
});

test("a count that comes before the records moves on only once they have all come", async () => {
  const candidates = await ids(2);
  const [first = "", second = ""] = await rank(candidates, "state");
  const [catalogObject, controlObject] = objects;
  const sent: { link?: Link } = {};
  const j = await joining([
    {
      id: first,
      respond: (link, ask) => {
        sent.link = link;
        link.send({ type: "state-sent", ask, count: 2 });
        if (catalogObject !== undefined) link.deliver(catalogObject.key, catalogObject.sealed);
      },
    },
    { id: second, records: whole },
  ]);
  await j.ask.start(candidates);
  await j.network.settle();
  expect(j.asked).toEqual([first]);

  if (controlObject !== undefined) sent.link?.deliver(controlObject.key, controlObject.sealed);
  await j.network.settle();
  expect(j.asked).toEqual([first, second]);
  expect(j.records.complete()).toBe(true);
});

test("an object that isn't one of the source's records neither counts nor moves the ask on", async () => {
  const candidates = await ids(2);
  const [first = "", second = ""] = await rank(candidates, "state");
  const held = holdingBack();
  const j = await joining([
    { id: first, respond: held.respond },
    { id: second, records: whole },
  ]);
  await j.ask.start(candidates);
  await j.network.settle();
  await j.ask.delivered(first, "caps/someone@1", new Uint8Array(8));
  expect(j.asked).toEqual([first]);
});

test("an ask that runs out of peers ends, and starts again with new ones", async () => {
  const [partial = "", full = ""] = await ids(2);
  const j = await joining([
    { id: partial, records: part },
    { id: full, records: whole },
  ]);
  await j.ask.start([partial]);
  await j.network.settle();
  expect(j.asked).toEqual([partial]);
  expect(j.records.complete()).toBe(false);

  await j.ask.start([partial, full]);
  await j.network.settle();
  expect(j.records.complete()).toBe(true);
});

test("only well-formed state messages are taken", () => {
  const bad = [
    null,
    "state-request",
    { type: "state-request" },
    { type: "state-request", ask: 0 },
    { type: "state-sent", ask: 1 },
    { type: "state-sent", ask: 1, count: 0 },
    { type: "chat-gone", ask: 1 },
  ];
  expect(bad.map(checkStateControl)).toEqual(bad.map(() => undefined));
  expect(checkStateControl({ type: "state-sent", ask: 2, count: 4, extra: true })).toEqual({
    type: "state-sent",
    ask: 2,
    count: 4,
  });
});

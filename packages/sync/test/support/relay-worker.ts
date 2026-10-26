// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The relay tests' side in Chromium (test/relay.test.ts), in a dedicated worker, where the chat
// store's OPFS sync access handles work. Each scenario runs peers against the relay and posts
// back what they saw; the test asserts on it. Waiting is on events: each peer's `until` resolves
// once a check holds after something it watches has changed.

import { openChat } from "../../src/chat-session";
import { openChunk, sealChunk } from "../../src/chunk";
import { contentKey, generateKeyPair, keyId, type Bytes, type KeyId } from "../../src/crypto";
import type { Link } from "../../src/link";
import {
  connectRelay,
  frame,
  RelayRequestError,
  unframe,
  type RelayOptions,
} from "../../src/relay";
import { joinGrant, peerToken, sourceToken, type JoinGrant } from "../../src/relay-auth";
import { createSourceRecords, sealSourceRecord, type SourceRecord } from "../../src/source-records";
import { rejection } from "./rejection";
import { editRights } from "./relay-edit";
import { watch } from "./watch";

export type RelayConfig = { url: string; hash: string };
export type Scenario = keyof typeof scenarios;

type Relay = Awaited<ReturnType<typeof connectRelay>>;

// A new session, by the join grant its key signs.
async function newSession() {
  const key = await generateKeyPair();
  return joinGrant(key);
}

// Connects to the relay under test.
const dial = (config: RelayConfig, options: Omit<RelayOptions, "url">) =>
  connectRelay({
    url: config.url,
    serverCertificateHashes: [{ algorithm: "sha-256", value: Uint8Array.fromBase64(config.hash) }],
    ...options,
  });

async function peer(
  config: RelayConfig,
  grant: JoinGrant,
  tracks: string[] = [],
  known: Promise<CryptoKeyPair> = generateKeyPair(),
) {
  const pair = await known;
  const [id, token] = await Promise.all([keyId(pair.publicKey), peerToken(grant, pair)]);
  const relay = await dial(config, { session: grant.session, self: id, token, tracks });
  return { pair, id, relay, ...watch() };
}

// Presence: each peer sees the other come online, and go when it leaves.
async function presence(config: RelayConfig) {
  const grant = await newSession();
  const alice = await peer(config, grant);
  const seen: string[] = [];
  alice.relay.on("announce", () => void seen.push("announce"));
  alice.relay.on("unannounce", () => void seen.push("unannounce"));
  alice.relay.on("announce", alice.changed);
  alice.relay.on("unannounce", alice.changed);
  alice.relay.listen();

  const bob = await peer(config, grant);
  const bobSaw: KeyId[] = [];

  bob.relay.on("announce", (other) => {
    bobSaw.push(other);
    bob.changed();
  });

  bob.relay.listen();
  await Promise.all([alice.until(() => seen.length === 1), bob.until(() => bobSaw.length === 1)]);
  await bob.relay.close();
  await alice.until(() => seen.length === 2);
  await alice.relay.close();
  return { aliceSaw: seen, bobSawAlice: bobSaw[0] === alice.id };
}

// Links: one opens between two online peers, carries a message each way and an object, and
// closes when one of them leaves.
async function links(config: RelayConfig) {
  const grant = await newSession();
  const [alice, bob] = await Promise.all([peer(config, grant), peer(config, grant)]);
  const heard: unknown[] = [];
  const objects: Array<{ key: string; text: string }> = [];
  const opened: Record<string, Link> = {};
  const closed: string[] = [];

  for (const [name, member] of [
    ["alice", alice],
    ["bob", bob],
  ] as const) {
    member.relay.on("link", (link) => {
      opened[name] = link;
      link.on("message", (value) => void heard.push({ to: name, value }));
      link.on(
        "object",
        (key, bytes) => void objects.push({ key, text: new TextDecoder().decode(bytes) }),
      );
      link.on("close", () => void closed.push(name));
      for (const event of ["message", "object", "close"] as const) link.on(event, member.changed);
      member.changed();
    });
  }

  alice.relay.listen();
  bob.relay.listen();
  await Promise.all([alice.until(() => "alice" in opened), bob.until(() => "bob" in opened)]);
  opened.alice!.send({ type: "chat-gone", author: alice.id, firstSeq: 1 });
  opened.bob!.send({ type: "chat-gone", author: bob.id, firstSeq: 2 });
  opened.bob!.deliver(`chat/${bob.id}/1-1`, new TextEncoder().encode("batch"));
  await Promise.all([alice.until(() => objects.length === 1), bob.until(() => heard.length > 0)]);
  await alice.until(() => heard.length === 2);

  await bob.relay.close();
  await alice.until(() => closed.includes("alice"));
  await alice.relay.close();
  return {
    heard,
    objects,
    fromBob: objects.map((o) => o.key === `chat/${bob.id}/1-1`),
    // In no particular order: Bob's link closes with its connection, Alice's as Bob is withdrawn.
    closed: closed.toSorted(),
    peers: { alice: opened.bob!.peer === alice.id, bob: opened.alice!.peer === bob.id },
  };
}

// Rejoining: a peer that leaves and comes back with the same key opens a new link with a peer
// that stayed, which carries messages as the first did.
async function rejoin(config: RelayConfig) {
  const grant = await newSession();
  const alice = await peer(config, grant);
  const seen: Link[] = [];
  const heard: unknown[] = [];
  const closed = { count: 0 };

  alice.relay.on("link", (link) => {
    seen.push(link);
    link.on("message", (value) => void heard.push(value));
    link.on("message", alice.changed);
    link.on("close", () => void closed.count++);
    link.on("close", alice.changed);
    alice.changed();
  });

  alice.relay.listen();
  const first = await peer(config, grant);
  first.relay.listen();
  await alice.until(() => seen.length === 1);
  await first.relay.close();
  await alice.until(() => closed.count === 1);

  const again = await peer(config, grant, [], Promise.resolve(first.pair));
  const fromAlice: unknown[] = [];

  again.relay.on("link", (link) => {
    link.on("message", (value) => void fromAlice.push(value));
    link.on("message", again.changed);
    link.send({ type: "chat-gone", author: again.id, firstSeq: 3 });
  });

  again.relay.listen();
  await alice.until(() => seen.length === 2);
  seen[1]!.send({ type: "chat-gone", author: alice.id, firstSeq: 4 });
  await Promise.all([
    alice.until(() => heard.length === 1),
    again.until(() => fromAlice.length === 1),
  ]);
  await Promise.all([alice.relay.close(), again.relay.close()]);
  return { samePeer: seen[1]!.peer === first.id, heard, fromAlice };
}

// A peer's chat over the relay: its track carries what it writes, and its links repairs.
async function chatter(config: RelayConfig, grant: JoinGrant, content: CryptoKey) {
  const member = await peer(config, grant, ["chat"]);
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(`relay-${crypto.randomUUID()}`, { create: true });
  const track = member.relay.track("chat");
  const chat = await openChat({
    peer: member.pair,
    content,
    session: dir,
    publish: (key, bytes) => track.send(frame(key, bytes)),
    onChange: member.changed,
  });
  const ready = { links: 0, subscriptions: 0 };

  async function received(payload: Bytes) {
    const object = unframe(payload);
    if (object !== undefined) await chat.received(object.key, object.bytes);
  }

  async function subscribe(relay: Relay, other: KeyId) {
    await relay.subscribe(other, "chat", received);
    ready.subscriptions++;
    member.changed();
  }

  member.relay.on("announce", (other) => void subscribe(member.relay, other));

  member.relay.on("link", (link) => {
    chat.connect(link);
    ready.links++;
    member.changed();
  });

  member.relay.listen();

  async function say(text: string) {
    await chat.write({ kind: "text", text }, 0);
    await chat.writable();
  }

  const texts = () => chat.entries().map((e) => e.text);
  return { ...member, chat, ready, say, texts };
}

// Chat: what one peer writes reaches the others through its track, and a peer that joins late
// catches up through a link from one version vector.
async function chatting(config: RelayConfig) {
  const grant = await newSession();
  const content = await contentKey(crypto.getRandomValues(new Uint8Array(32)), grant.session);
  const [alice, bob] = await Promise.all([
    chatter(config, grant, content),
    chatter(config, grant, content),
  ]);
  const both = (m: typeof alice) =>
    m.until(() => m.ready.links === 1 && m.ready.subscriptions === 1);
  await Promise.all([both(alice), both(bob)]);

  await alice.say("one");
  await alice.say("two");
  await bob.until(() => bob.texts().length === 2);

  const carol = await chatter(config, grant, content);
  await carol.until(() => carol.ready.links === 2 && carol.ready.subscriptions === 2);
  await carol.chat.reconnected();
  await carol.until(() => carol.texts().length === 2);
  await alice.until(() => alice.ready.links === 2 && alice.ready.subscriptions === 2);
  await alice.say("three");
  await Promise.all([carol, bob].map((m) => m.until(() => m.texts().length === 3)));

  const result = { bob: bob.texts(), carol: carol.texts() };
  await Promise.all([alice, bob, carol].map((m) => m.chat.close()));
  await Promise.all([alice, bob, carol].map((m) => m.relay.close()));
  return result;
}

// What `call` throws, or undefined.
function thrown(call: () => unknown) {
  try {
    call();
  } catch (error) {
    return error;
  }

  return undefined;
}

// Refusals: a subscription to a track nobody publishes, a track this peer doesn't publish, and a
// subscription or a send once the connection has closed.
async function refused(config: RelayConfig) {
  const grant = await newSession();
  const alice = await peer(config, grant, ["chat"]);
  const other = await generateKeyPair();
  const nobody = await keyId(other.publicKey);
  const subscribe = () => alice.relay.subscribe(nobody, "chat", () => undefined);
  const unpublished = await rejection(subscribe());
  const ownTrack = thrown(() => alice.relay.track("have"));
  const sourceTrack = thrown(() => alice.relay.sourceTrack("catalog"));
  const chat = alice.relay.track("chat");
  await alice.relay.close();
  const afterClose = await rejection(subscribe());
  const sent = thrown(() => chat.send(new Uint8Array(1)));
  return {
    refused: unpublished instanceof RelayRequestError,
    notPublished: [ownTrack, sourceTrack].map((e) => e instanceof Error),
    closed: [afterClose, sent].map((e) => e instanceof RelayRequestError),
  };
}

// Whether the relay refuses a token, by ending the connection once it has asked the auth server.
async function refusesToken(config: RelayConfig, options: Omit<RelayOptions, "url">) {
  const relay = await dial(config, options);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  relay.on("close", resolve);
  return promise;
}

// Admission: the relay admits a peer whose token is for the session it dials, and refuses one
// for another session, or under a grant the session key didn't sign.
async function admission(config: RelayConfig) {
  const [grant, other, pair] = await Promise.all([newSession(), newSession(), generateKeyPair()]);
  const [self, elsewhere, forged] = await Promise.all([
    keyId(pair.publicKey),
    peerToken(other, pair),
    peerToken({ ...other, session: grant.session }, pair),
  ]);
  const session = grant.session;
  const outcomes = await Promise.all(
    [elsewhere, forged].map((token) => refusesToken(config, { session, self, token, tracks: [] })),
  );

  const bob = await peer(config, grant);
  const online: KeyId[] = [];

  bob.relay.on("announce", (id) => {
    online.push(id);
    bob.changed();
  });

  bob.relay.listen();
  const alice = await peer(config, grant);
  await bob.until(() => online.includes(alice.id));
  await Promise.all([alice.relay.close(), bob.relay.close()]);
  return { admitted: online.includes(alice.id), elsewhere: outcomes[0], forged: outcomes[1] };
}

// An impostor: a peer the relay admits can't announce itself as another peer, so nobody sees
// that one online or can subscribe to its tracks.
async function impostor(config: RelayConfig) {
  const grant = await newSession();
  const [victim, mallory] = await Promise.all([generateKeyPair(), generateKeyPair()]);
  const [victimId, token] = await Promise.all([keyId(victim.publicKey), peerToken(grant, mallory)]);
  const bob = await peer(config, grant);
  const online: KeyId[] = [];

  bob.relay.on("announce", (other) => {
    online.push(other);
    bob.changed();
  });

  bob.relay.listen();
  const fake = await dial(config, {
    session: grant.session,
    self: victimId,
    token,
    tracks: ["chat"],
  });
  // The relay admits a connection only after making it. Once the impostor sees Bob it has been
  // admitted, with whatever it announced; Carol connects after that, so once Bob sees her, he
  // would have seen the impostor too.
  const fakeSaw = { bob: false, ...watch() };

  fake.on("announce", (other) => {
    fakeSaw.bob ||= other === bob.id;
    fakeSaw.changed();
  });

  fake.listen();
  await fakeSaw.until(() => fakeSaw.bob);
  const carol = await peer(config, grant);
  await bob.until(() => online.includes(carol.id));
  const subscription = { refused: false };

  try {
    const cancel = await bob.relay.subscribe(victimId, "chat", () => undefined);
    cancel();
  } catch (error) {
    subscription.refused = error instanceof RelayRequestError;
  }

  await Promise.all([fake, bob.relay, carol.relay].map((relay) => relay.close()));
  return { sawImpostor: online.includes(victimId), subscribeRefused: subscription.refused };
}

type Peer = Awaited<ReturnType<typeof peer>>;

// The session the source scenario runs in: its key pair, join grant and content key.
type SourceSession = { pair: CryptoKeyPair; grant: JoinGrant; content: CryptoKey };

// Mallory publishes `source` with a peer's token: once Bob sees her she has been admitted, with
// whatever she announced, `source` first. What Bob's subscription to her `source` rejects with.
async function forgedSource(config: RelayConfig, grant: JoinGrant, bob: Peer, online: KeyId[]) {
  const mallory = await generateKeyPair();
  const [malloryId, malloryToken] = await Promise.all([
    keyId(mallory.publicKey),
    peerToken(grant, mallory),
  ]);
  const forged = await dial(config, {
    session: grant.session,
    self: malloryId,
    token: malloryToken,
    tracks: [],
    source: ["catalog"],
  });
  await bob.until(() => online.includes(malloryId));
  const refusal = await rejection(bob.relay.subscribeSource("catalog", () => undefined));
  await forged.close();
  return refusal;
}

// The source, connected with its token and listening; `asked` holds once a peer messages it.
async function connectSource(config: RelayConfig, session: SourceSession) {
  const sourcePair = await generateKeyPair();
  const [id, token] = await Promise.all([
    keyId(sourcePair.publicKey),
    sourceToken(session.pair, sourcePair),
  ]);
  const relay = await dial(config, {
    session: session.grant.session,
    self: id,
    token,
    tracks: [],
    source: ["catalog", "control", "init/0", "media/0"],
  });
  const asked = { now: false, ...watch() };

  relay.on("link", (link) => {
    link.on("message", () => {
      asked.now = true;
      asked.changed();
    });
  });

  relay.listen();
  return { id, relay, asked };
}

// What the source publishes: its catalog, control record and codec setup, then two chunks of
// two seconds, each a keyframe and the frame after it.
async function publishSource(source: Relay, session: SourceSession) {
  const { pair, content } = session;
  const catalog = {
    version: 1,
    durationUs: 10_000_000,
    tracks: [{ id: 0, kind: "video" as const, codec: "vp09.00.10.08", bitrateKbps: 900 }],
  };
  const setup = { track: 0, codec: "vp09.00.10.08", codedWidth: 64, codedHeight: 48 };
  const control = { epoch: 1, playing: true, mediaUs: 0, atUs: 5, ended: false };
  const published: Array<{ track: string; record: SourceRecord }> = [
    { track: "catalog", record: { kind: "catalog", catalog } },
    { track: "control", record: { kind: "control", control } },
    { track: "init/0", record: { kind: "setup", setup } },
  ];
  const objects = await Promise.all(
    published.map(async ({ track, record }) => {
      const object = await sealSourceRecord(pair, content, record);
      return { track, object };
    }),
  );

  for (const { track, object } of objects) {
    source.sourceTrack(track).send(frame(object.key, object.sealed));
  }

  const sealedChunks = await Promise.all(
    [0, 1].map(async (index) => {
      const startUs = index * 2_000_000;
      const packets = [startUs, startUs + 40_000].map((ptsUs, i) => ({
        ptsUs,
        dtsUs: ptsUs,
        durationUs: 40_000,
        keyframe: i === 0,
        data: new Uint8Array(1_000).fill(index),
      }));
      return sealChunk(pair, content, {
        track: 0,
        index,
        startUs,
        endUs: startUs + 2_000_000,
        packets,
      });
    }),
  );
  for (const { key, sealed } of sealedChunks)
    source.sourceTrack("media/0").send(frame(key, sealed));
}

// What Bob takes from the source's tracks: the kinds of record he keeps, the chunks he opens,
// and why anything was rejected.
function sourceReceiver(bob: Peer, session: SourceSession) {
  const kept: string[] = [];
  const rejected: string[] = [];
  const records = createSourceRecords({
    sessionKey: session.pair.publicKey,
    content: session.content,
    onRecord: (record) => {
      kept.push(record.kind);
      bob.changed();
    },
  });

  // Takes what arrives on a `source` track. A record that is rejected fails the test with the
  // reason, rather than leaving it waiting.
  async function take(payload: Bytes) {
    const framed = unframe(payload);
    if (framed === undefined) return;

    try {
      await records.receive({ key: framed.key, sealed: new Uint8Array(framed.bytes) });
    } catch (error) {
      rejected.push(`${framed.key}: ${String(error)}`);
      bob.changed();
    }
  }

  // The slot and time range of each chunk Bob opens.
  const chunks: Array<{ index: number; startUs: number; endUs: number; packets: number }> = [];

  async function takeChunk(payload: Bytes) {
    const framed = unframe(payload);
    if (framed === undefined) return;

    try {
      const object = { key: framed.key, sealed: new Uint8Array(framed.bytes) };
      const chunk = await openChunk(session.pair.publicKey, session.content, object);
      const { index, startUs, endUs, packets } = chunk;
      chunks.push({ index, startUs, endUs, packets: packets.length });
    } catch (error) {
      rejected.push(`${framed.key}: ${String(error)}`);
    }

    bob.changed();
  }

  const subscribed = () =>
    Promise.all([
      bob.relay.subscribeSource("catalog", take),
      bob.relay.subscribeSource("control", take),
      bob.relay.subscribeSource("init/0", take),
      bob.relay.subscribeSource("media/0", takeChunk),
    ]);
  const done = () => (kept.length === 3 && chunks.length === 2) || rejected.length > 0;
  return { rejected, records, chunks, subscribed, done };
}

// The source's records: only the source's token lets a peer publish `source`, and what the source
// publishes there, its records and chunks, reaches the others sealed and framed with its key, and
// checks out.
async function sourceRecords(config: RelayConfig) {
  const pair = await generateKeyPair();
  const grant = await joinGrant(pair);
  const content = await contentKey(crypto.getRandomValues(new Uint8Array(32)), grant.session);
  const session: SourceSession = { pair, grant, content };
  const bob = await peer(config, grant);
  const online: KeyId[] = [];
  const bobLinks: Link[] = [];

  bob.relay.on("announce", (id) => {
    online.push(id);
    bob.changed();
  });

  bob.relay.on("link", (link) => {
    bobLinks.push(link);
    bob.changed();
  });

  bob.relay.listen();
  const forgedRefused = await forgedSource(config, grant, bob, online);
  const source = await connectSource(config, session);
  const linked = () => bobLinks.some((l) => l.peer === source.id);
  await bob.until(() => online.includes(source.id) && linked());

  const receiver = sourceReceiver(bob, session);
  await receiver.subscribed();
  // Bob's subscriptions are in place before the source publishes, since nothing may rely on the
  // groups a publisher keeps for later subscribers: once the source hears Bob, it publishes.
  bobLinks
    .find((l) => l.peer === source.id)
    ?.send({ type: "chat-gone", author: bob.id, firstSeq: 1 });
  await source.asked.until(() => source.asked.now);
  await publishSource(source.relay, session);

  await bob.until(receiver.done);
  await Promise.all([source.relay.close(), bob.relay.close()]);
  const { rejected, records, chunks } = receiver;
  return {
    forgedRefused: forgedRefused instanceof RelayRequestError,
    rejected,
    catalog: records.catalog(),
    control: records.control(),
    setup: records.setup(0),
    // Objects may arrive in any order.
    chunks: chunks.toSorted((a, b) => a.index - b.index),
  };
}

const scenarios = {
  presence,
  links,
  rejoin,
  chat: chatting,
  refused,
  admission,
  impostor,
  source: sourceRecords,
  editRights,
};

async function run({ scenario, config }: { scenario: Scenario; config: RelayConfig }) {
  try {
    const result = await scenarios[scenario](config);
    postMessage({ result });
  } catch (error) {
    postMessage({
      error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error),
    });
  }
}

// A rejection nothing handles fails the scenario rather than leaving it waiting.
addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  const { reason }: { reason: unknown } = event;
  postMessage({
    error: reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason),
  });
});

addEventListener(
  "message",
  ({ data }: MessageEvent<{ scenario: Scenario; config: RelayConfig }>) => {
    void run(data);
  },
);

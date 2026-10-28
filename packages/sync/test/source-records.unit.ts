// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The source's records as a peer holds them (src/source-records.ts), in Chromium: what the source
// seals is kept, read and passed on unchanged; only a newer catalog or control record, or a page
// of the chunk index listing more chunks, replaces the one held, whatever order they arrive in,
// and a track keeps its first setup; the whole state takes every page of the index up to the
// last held; and an object that doesn't open, isn't a source record or isn't the session's is
// rejected, changing nothing.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import type { Catalog, CodecSetup } from "../src/catalog";
import type { Control } from "../src/control";
import { contentKey, generateKeyPair, keyId, seal, type SealedObject } from "../src/crypto";
import { InvalidRecordError } from "../src/signed-record";
import { createSourceRecords, sealSourceRecord, type SourceRecord } from "../src/source-records";
import { rejection } from "./support/rejection";

const session = await generateKeyPair();
const sessionId = await keyId(session.publicKey);
const content = await contentKey(crypto.getRandomValues(new Uint8Array(32)), sessionId);

const catalog: Catalog = {
  version: 1,
  durationUs: 5_400_000_000,
  tracks: [
    { id: 0, kind: "video", codec: "avc1.640028", bitrateKbps: 4_800 },
    { id: 1, kind: "audio", codec: "opus", bitrateKbps: 128 },
  ],
};
const control: Control = {
  epoch: 1,
  playing: false,
  mediaUs: 0,
  atUs: 1_793_000_000_000_000,
  ended: false,
};
const video: CodecSetup = { track: 0, codec: "avc1.640028", codedWidth: 1920, codedHeight: 1080 };
const audio: CodecSetup = { track: 1, codec: "opus", sampleRate: 48_000, numberOfChannels: 2 };

const sealed = async (record: SourceRecord) => sealSourceRecord(session, content, record);

// The bounds of `count` chunks of 2 s each from 0 s: a full page of the index is 64.
const twoSeconds = (count: number) => Array.from({ length: count + 1 }, (_, i) => i * 2_000_000);

// A peer's records, with every record it reports kept.
function peer() {
  const reported: SourceRecord[] = [];
  const records = createSourceRecords({
    sessionKey: session.publicKey,
    content,
    onRecord: (record) => reported.push(record),
  });
  return { records, reported };
}

// Receives objects one after another, so the setups are held in a known order.
async function receiveAll(
  records: ReturnType<typeof createSourceRecords>,
  objects: SealedObject[],
) {
  const kept = [];

  for (const object of objects) {
    const one = await records.receive(object);
    kept.push(one);
  }

  return kept;
}

test("what the source seals is kept, read, and passed on unchanged", async () => {
  const objects = await Promise.all([
    sealed({ kind: "catalog", catalog }),
    sealed({ kind: "control", control }),
    sealed({ kind: "setup", setup: video }),
    sealed({ kind: "setup", setup: audio }),
  ]);
  const bob = peer();
  const kept = await receiveAll(bob.records, objects);
  expect(kept).toEqual([true, true, true, true]);
  expect(bob.records.catalog()).toEqual(catalog);
  expect(bob.records.control()).toEqual(control);
  expect(bob.records.setup(0)).toEqual(video);
  expect(bob.records.setup(1)).toEqual(audio);
  expect(bob.records.setup(2)).toBeUndefined();
  expect(bob.reported).toEqual([
    { kind: "catalog", catalog },
    { kind: "control", control },
    { kind: "setup", setup: video },
    { kind: "setup", setup: audio },
  ]);
  expect(bob.records.objects()).toEqual(objects);

  // Carol takes them from Bob, as a joiner takes state from any peer.
  const carol = peer();
  await receiveAll(carol.records, bob.records.objects());
  expect(carol.records.catalog()).toEqual(catalog);
  expect(carol.records.control()).toEqual(control);
  expect(carol.records.objects()).toEqual(objects);
});

test("only a newer catalog or control record replaces the one held, in any order of arrival", async () => {
  const [catalog1, catalog2, control2, control3] = await Promise.all([
    sealed({ kind: "catalog", catalog }),
    sealed({ kind: "catalog", catalog: { ...catalog, version: 2, chunkCount: 2_700 } }),
    sealed({ kind: "control", control: { ...control, epoch: 2, playing: true } }),
    sealed({ kind: "control", control: { ...control, epoch: 3, mediaUs: 60_000_000 } }),
  ]);
  const bob = peer();
  const kept = await receiveAll(bob.records, [catalog2, catalog1, catalog2, control3, control2]);
  expect(kept).toEqual([true, false, false, true, false]);
  expect(bob.records.catalog()?.version).toBe(2);
  expect(bob.records.control()?.epoch).toBe(3);
  expect(bob.reported.map((r) => r.kind)).toEqual(["catalog", "control"]);
  expect(bob.records.objects()).toEqual([catalog2, control3]);
});

test("a record that arrives twice at once is kept once", async () => {
  const object = await sealed({ kind: "control", control });
  const bob = peer();
  const kept = await Promise.all([bob.records.receive(object), bob.records.receive(object)]);
  expect(kept.toSorted()).toEqual([false, true]);
  expect(bob.reported.length).toBe(1);
});

test("a track keeps its first setup", async () => {
  const [first, again] = await Promise.all([
    sealed({ kind: "setup", setup: video }),
    sealed({ kind: "setup", setup: video }),
  ]);
  const bob = peer();
  const kept = await receiveAll(bob.records, [first, again]);
  expect(kept).toEqual([true, false]);
  expect(bob.records.objects()).toEqual([first]);
});

test("an object that doesn't open, isn't a source record or isn't the session's is rejected", async () => {
  const other = await generateKeyPair();
  const otherContent = await contentKey(crypto.getRandomValues(new Uint8Array(32)), sessionId);
  const [object, fromOther, underOtherKey] = await Promise.all([
    sealed({ kind: "catalog", catalog }),
    sealSourceRecord(other, content, { kind: "catalog", catalog }),
    sealSourceRecord(session, otherContent, { kind: "catalog", catalog }),
  ]);
  const asChat = await seal(content, "chat/a/1-1", object.sealed);
  const chat = { key: "chat/a/1-1", sealed: asChat };
  const bob = peer();
  const errors = await Promise.all([
    rejection(bob.records.receive({ key: "catalog@2", sealed: object.sealed })),
    rejection(bob.records.receive(underOtherKey)),
    rejection(bob.records.receive(chat)),
    rejection(bob.records.receive(fromOther)),
  ]);
  expect(errors).toEqual([
    new InvalidRecordError("doesn't open"),
    new InvalidRecordError("doesn't open"),
    new InvalidRecordError("not a source record: chat/a/1-1"),
    new InvalidRecordError("bad signature"),
  ]);
  expect(bob.records.catalog()).toBeUndefined();
  expect(bob.records.objects()).toEqual([]);
  expect(bob.reported).toEqual([]);
});

test("each page of the index is replaced only by one listing more chunks, and passed on with the rest", async () => {
  // Page 0 full, 64 chunks of 2 s, then page 1 with one chunk and with two. Sizes don't matter
  // here: any positive ones will do, such as the bounds themselves.
  const full = twoSeconds(64);
  const [first, oneMore, twoMore, catalogObject] = await Promise.all([
    sealed({ kind: "index", page: { page: 0, bounds: full, bytes: full.slice(1) } }),
    sealed({ kind: "index", page: { page: 1, bounds: [128_000_000, 130_000_000], bytes: [1] } }),
    sealed({
      kind: "index",
      page: { page: 1, bounds: [128_000_000, 130_000_000, 133_000_000], bytes: [1, 2] },
    }),
    sealed({ kind: "catalog", catalog }),
  ]);
  expect([first.key, oneMore.key, twoMore.key]).toEqual(["index/0@64", "index/1@1", "index/1@2"]);
  const bob = peer();
  const kept = await receiveAll(bob.records, [
    oneMore,
    twoMore,
    oneMore,
    catalogObject,
    first,
    twoMore,
  ]);
  expect(kept).toEqual([true, true, false, true, true, false]);
  expect(bob.records.index()).toEqual({
    bounds: [...full, 130_000_000, 133_000_000],
    bytes: [...full.slice(1), 1, 2],
  });
  expect(bob.reported.map((r) => r.kind)).toEqual(["index", "index", "catalog", "index"]);
  expect(bob.records.objects()).toEqual([catalogObject, twoMore, first]);
});

test("the whole state takes every page of the index up to the last held, and none when none is held", async () => {
  const objects = await Promise.all([
    sealed({ kind: "catalog", catalog }),
    sealed({ kind: "control", control }),
    sealed({ kind: "setup", setup: video }),
    sealed({ kind: "setup", setup: audio }),
  ]);
  // Page 0 one chunk short of full, then full, and page 1, which starts where the full page ends.
  const [short, full, next] = await Promise.all([
    sealed({
      kind: "index",
      page: { page: 0, bounds: twoSeconds(63), bytes: twoSeconds(63).slice(1) },
    }),
    sealed({
      kind: "index",
      page: { page: 0, bounds: twoSeconds(64), bytes: twoSeconds(64).slice(1) },
    }),
    sealed({ kind: "index", page: { page: 1, bounds: [128_000_000, 130_000_000], bytes: [1] } }),
  ]);
  const bob = peer();
  await receiveAll(bob.records, objects);
  const complete = [bob.records.complete()];

  for (const object of [next, short, full]) {
    await bob.records.receive(object);
    complete.push(bob.records.complete());
  }

  expect(complete).toEqual([true, false, false, true]);
});

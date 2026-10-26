// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The source's records (src/catalog.ts), in Chromium: a catalog and a codec setup round-trip
// under the object keys that name them; a malformed one is refused before signing; and one that
// is signed by another session, altered, carries an unsigned field, sits under another key, or
// is signed as the other kind of record is rejected.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import {
  decodeCatalog,
  decodeSetup,
  encodeCatalog,
  encodeSetup,
  type Catalog,
  type CodecSetup,
} from "../src/catalog";
import { generateKeyPair } from "../src/crypto";
import { InvalidRecordError } from "../src/signed-record";
import { rejection } from "./support/rejection";
import { createRecordSigner, json } from "./support/signed-record";

const { pair, resigned } = await createRecordSigner();
const encoder = new TextEncoder();

const catalog: Catalog = {
  version: 2,
  durationUs: 5_400_000_000,
  tracks: [
    { id: 0, kind: "video", codec: "avc1.640028", bitrateKbps: 4_800 },
    { id: 1, kind: "audio", codec: "opus", bitrateKbps: 128, language: "en", title: "Stereo" },
    { id: 2, kind: "subtitle", codec: "webvtt", bitrateKbps: 1, language: "fr" },
  ],
  chunkCount: 2_700,
};

const video: CodecSetup = {
  track: 0,
  codec: "avc1.640028",
  description: new Uint8Array([1, 0x64, 0, 0x28, 0xff]),
  codedWidth: 1920,
  codedHeight: 1080,
};

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// A catalog as a caller without types might pass one, whatever its fields.
const untyped = (value: object): Catalog => JSON.parse(JSON.stringify(value));

test("a catalog round-trips under the key of its version", async () => {
  const { key, bytes } = await encodeCatalog(pair, catalog);
  expect(key).toBe("catalog@2");
  const read = await decodeCatalog(pair.publicKey, key, bytes);
  expect(read).toEqual(catalog);
});

test("a codec setup round-trips under the key of its track, with or without a description", async () => {
  const subtitle: CodecSetup = { track: 2, codec: "webvtt" };
  const audio: CodecSetup = { track: 1, codec: "opus", sampleRate: 48_000, numberOfChannels: 2 };

  for (const setup of [video, subtitle, audio]) {
    const { key, bytes } = await encodeSetup(pair, setup);
    expect(key).toBe(`init/${setup.track}`);
    const read = await decodeSetup(pair.publicKey, key, bytes);
    expect(read).toEqual(setup);
  }
});

test("a malformed record is refused before it is signed", async () => {
  const [first, second] = catalog.tracks;
  if (first === undefined || second === undefined) throw new Error("the catalog has tracks");
  const catalogs = [
    { ...catalog, version: 0 },
    { ...catalog, durationUs: -1 },
    { ...catalog, chunkCount: 1.5 },
    { ...catalog, tracks: [first, { ...second, id: 0 }] },
    { ...catalog, tracks: [{ ...first, id: 65_536 }] },
    { ...catalog, tracks: [{ ...first, codec: "" }] },
    { ...catalog, tracks: [{ ...first, kind: "image" }] },
    { ...catalog, extra: true },
    { ...catalog, tracks: "none" },
    { ...catalog, tracks: [1] },
    { ...catalog, tracks: [{ ...first, language: "" }] },
    { ...catalog, tracks: [{ ...first, title: 7 }] },
    [catalog],
  ];
  const setups = [
    { ...video, track: -1 },
    { ...video, codedWidth: 0 },
    { ...video, sampleRate: 44_100.5 },
    { ...video, codec: "" },
  ];
  const fromCatalogs = catalogs.map(async (c) => rejection(encodeCatalog(pair, untyped(c))));
  const fromSetups = setups.map(async (s) => rejection(encodeSetup(pair, s)));
  const errors = await Promise.all([...fromCatalogs, ...fromSetups]);
  expect(errors.every((e) => e instanceof InvalidRecordError)).toBe(true);
});

test("a record signed by another session is rejected", async () => {
  const other = await generateKeyPair();
  const [fromCatalog, fromSetup] = await Promise.all([
    encodeCatalog(other, catalog),
    encodeSetup(other, video),
  ]);
  const errors = await Promise.all([
    rejection(decodeCatalog(pair.publicKey, fromCatalog.key, fromCatalog.bytes)),
    rejection(decodeSetup(pair.publicKey, fromSetup.key, fromSetup.bytes)),
  ]);
  expect(errors).toEqual([
    new InvalidRecordError("bad signature"),
    new InvalidRecordError("bad signature"),
  ]);
});

test("an altered record, or one with a field nobody signed, is rejected", async () => {
  const { key, bytes } = await encodeCatalog(pair, catalog);
  const record = json(bytes);
  const altered = encoder.encode(JSON.stringify({ ...record, durationUs: 1 }));
  const added = encoder.encode(JSON.stringify({ ...record, live: true }));
  const errors = await Promise.all([
    rejection(decodeCatalog(pair.publicKey, key, altered)),
    rejection(decodeCatalog(pair.publicKey, key, added)),
    rejection(decodeCatalog(pair.publicKey, key, encoder.encode("{"))),
  ]);
  expect(errors).toEqual([
    new InvalidRecordError("bad signature"),
    new InvalidRecordError("unknown field live"),
    new InvalidRecordError("not UTF-8 JSON"),
  ]);
});

test("a codec setup with a field nobody signed, or a description that isn't base64url text, is rejected", async () => {
  const { key, bytes } = await encodeSetup(pair, video);
  const [added, numeric, garbled] = await Promise.all([
    resigned(bytes, "snowy init v1", (record) => (record.profile = "high")),
    resigned(bytes, "snowy init v1", (record) => (record.description = 7)),
    resigned(bytes, "snowy init v1", (record) => (record.description = "not base64!")),
  ]);
  const errors = await Promise.all([
    rejection(decodeSetup(pair.publicKey, key, added)),
    rejection(decodeSetup(pair.publicKey, key, numeric)),
    rejection(decodeSetup(pair.publicKey, key, garbled)),
  ]);
  expect(errors).toEqual([
    new InvalidRecordError("unknown field profile"),
    new InvalidRecordError("bad description"),
    new InvalidRecordError("bad description"),
  ]);
});

test("a record under another object key is rejected", async () => {
  const [fromCatalog, fromSetup] = await Promise.all([
    encodeCatalog(pair, catalog),
    encodeSetup(pair, video),
  ]);
  const errors = await Promise.all([
    rejection(decodeCatalog(pair.publicKey, "catalog@3", fromCatalog.bytes)),
    rejection(decodeSetup(pair.publicKey, "init/1", fromSetup.bytes)),
  ]);
  expect(errors).toEqual([
    new InvalidRecordError("another version"),
    new InvalidRecordError("another track"),
  ]);
});

test("a codec setup signed as a catalog, or with its description spelled another way, is rejected", async () => {
  const { key, bytes } = await encodeSetup(pair, video);
  // Five bytes fill 40 of the 42 bits of seven base64url characters: flipping a spare bit spells
  // the same bytes another way.
  const description = String(json(bytes).description);
  const last = ALPHABET[ALPHABET.indexOf(description.slice(-1)) ^ 1];
  const respelled = `${description.slice(0, -1)}${last}`;
  const [asCatalog, otherSpelling] = await Promise.all([
    resigned(bytes, "snowy catalog v1", () => undefined),
    resigned(bytes, "snowy init v1", (record) => (record.description = respelled)),
  ]);
  const errors = await Promise.all([
    rejection(decodeSetup(pair.publicKey, key, asCatalog)),
    rejection(decodeSetup(pair.publicKey, key, otherSpelling)),
  ]);
  expect(errors).toEqual([
    new InvalidRecordError("bad signature"),
    new InvalidRecordError("bad description"),
  ]);
});

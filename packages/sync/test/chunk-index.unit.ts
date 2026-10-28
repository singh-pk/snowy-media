// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The chunk index (src/chunk-index.ts), in Chromium: a page round-trips under the key of its page
// and the chunks it lists; one with no chunk, more than a page, bounds out of order, other than
// one positive size per chunk, or an unsigned field is refused before signing; one signed by
// another session, altered, under another key or signed as another record is rejected; pages
// join from the first while each is full and starts where the last ends, with their sizes,
// reaching a page once they list a chunk of it; and the chunk covering a moment is found by time,
// before the first chunk and, once every chunk is listed, past the last.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import {
  chunkAt,
  decodeIndexPage,
  encodeIndexPage,
  joinedIndex,
  reachesPage,
  type IndexPage,
} from "../src/chunk-index";
import { generateKeyPair } from "../src/crypto";
import { InvalidRecordError } from "../src/signed-record";
import { rejection } from "./support/rejection";
import { createRecordSigner } from "./support/signed-record";

const { pair, resigned } = await createRecordSigner();
const SECOND = 1_000_000;
// Five chunks of 2, 5, 1, 8 and 9 s, the first starting at 5 s.
const bounds = [5, 7, 12, 13, 21, 30].map((s) => s * SECOND);
// Each chunk's sealed video size, made up for these five.
const sizes = [2_500_000, 6_100_000, 900_000, 9_800_000, 11_200_000];
const page: IndexPage = { page: 0, bounds, bytes: sizes };

// A page as a caller without types might pass one, whatever its fields.
const untyped = (value: unknown): IndexPage => JSON.parse(JSON.stringify(value));

// `count` chunks of 2 s each from `startS` seconds: a full page is 64, as the docs give it.
const twoSecond = (startS: number, count: number) =>
  Array.from({ length: count + 1 }, (_, i) => (startS + 2 * i) * SECOND);

// Sizes for `count` chunks from chunk `from` of the film: chunk n's video takes 1,000 × (n + 1) bytes.
const sized = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => 1_000 * (from + i + 1));

// Page `number` listing `count` chunks of 2 s from `startS` seconds, each sized as above.
const twoSecondPage = (number: number, startS: number, count: number): IndexPage => ({
  page: number,
  bounds: twoSecond(startS, count),
  bytes: sized(number * 64, count),
});

// The first `count` chunks of such a film, joined.
const film = (count: number) => ({ bounds: twoSecond(0, count), bytes: sized(0, count) });

test("a page round-trips under the key of its page and the chunks it lists", async () => {
  const { key, bytes } = await encodeIndexPage(pair, page);
  expect(key).toBe("index/0@5");
  const read = await decodeIndexPage(pair.publicKey, key, bytes);
  expect(read).toEqual(page);
  const [later, full] = await Promise.all([
    encodeIndexPage(pair, { page: 2, bounds: [0, 2 * SECOND], bytes: [1] }),
    encodeIndexPage(pair, twoSecondPage(0, 0, 64)),
  ]);
  expect([later.key, full.key]).toEqual(["index/2@1", "index/0@64"]);
});

test("a page with no chunk, more than 64, bounds out of order, other than one positive size per chunk, or an unsigned field isn't signed", async () => {
  const bad = [
    [0, 2],
    { bounds: [0, 2] },
    { page: -1, bounds: [0, 2] },
    { page: 0.5, bounds: [0, 2] },
    { page: 0, bounds: [] },
    { page: 0, bounds: [0] },
    { page: 0, bounds: twoSecond(0, 65) },
    { page: 0, bounds: [0, 2, 2] },
    { page: 0, bounds: [0, 3, 2] },
    { page: 0, bounds: [-1, 2] },
    { page: 0, bounds: [0, 1.5] },
    { page: 0, bounds: [0, "2"] },
    { page: 0, bounds: "0,2" },
    { page: 0, bounds: [0, 2], bytes: [1], ended: true },
    { page: 0, bounds: [0, 2] },
    { page: 0, bounds: [0, 2], bytes: [] },
    { page: 0, bounds: [0, 2], bytes: [1, 2] },
    { page: 0, bounds: [0, 2], bytes: [0] },
    { page: 0, bounds: [0, 2], bytes: [1.5] },
    { page: 0, bounds: [0, 2], bytes: ["1"] },
    { page: 0, bounds: [0, 2], bytes: 1 },
  ];
  const errors = await Promise.all(
    bad.map((value) => rejection(encodeIndexPage(pair, untyped(value)))),
  );
  expect(errors.map((e) => e instanceof InvalidRecordError)).toEqual(bad.map(() => true));
});

test("a page signed by another session, altered, under another key, or signed as another record is rejected", async () => {
  const other = await generateKeyPair();
  const [{ key, bytes }, elsewhere] = await Promise.all([
    encodeIndexPage(pair, page),
    encodeIndexPage(other, page),
  ]);
  const [shorter, moved, asCatalog, malformed, unsized] = await Promise.all([
    resigned(bytes, "snowy index v1", (record) => {
      record.bounds = bounds.slice(0, 3);
      record.bytes = sizes.slice(0, 2);
    }),
    resigned(bytes, "snowy index v1", (record) => (record.page = 1)),
    resigned(bytes, "snowy catalog v1", () => undefined),
    resigned(bytes, "snowy index v1", (record) => (record.bounds = [0, 2, 1])),
    resigned(bytes, "snowy index v1", (record) => (record.bytes = sizes.slice(1))),
  ]);
  const altered = new TextEncoder().encode(
    new TextDecoder().decode(bytes).replace(String(bounds[1]), String(bounds[1]! + 1)),
  );
  const errors = await Promise.all([
    rejection(decodeIndexPage(pair.publicKey, key, elsewhere.bytes)),
    rejection(decodeIndexPage(pair.publicKey, key, altered)),
    rejection(decodeIndexPage(pair.publicKey, "index/0@4", bytes)),
    rejection(decodeIndexPage(pair.publicKey, "index/1@5", bytes)),
    rejection(decodeIndexPage(pair.publicKey, key, shorter)),
    rejection(decodeIndexPage(pair.publicKey, key, moved)),
    rejection(decodeIndexPage(pair.publicKey, key, asCatalog)),
    rejection(decodeIndexPage(pair.publicKey, key, malformed)),
    rejection(decodeIndexPage(pair.publicKey, key, unsized)),
  ]);
  const reasons = [
    "bad signature",
    "bad signature",
    "another page",
    "another page",
    "another page",
    "another page",
    "bad signature",
    "bad bounds",
    "bad bytes",
  ];
  expect(errors).toEqual(reasons.map((reason) => new InvalidRecordError(reason)));
});

// The index that these pages join into.
const joined = (...pages: IndexPage[]) =>
  joinedIndex((number) => pages.find((p) => p.page === number));

test("pages join from the first while each is full and starts where the one before ends", () => {
  const first = twoSecondPage(0, 0, 64);
  const second = twoSecondPage(1, 128, 3);
  // Chunk 64 starts at 128 s, where page 0's last chunk ends.
  expect(joined(first, second)).toEqual(film(67));
  expect(joined(second, first)).toEqual(film(67));
  // Without page 0 nothing joins; a page after one that isn't full, or that starts elsewhere,
  // doesn't join.
  expect(joined(second)).toEqual({ bounds: [], bytes: [] });
  // Page 1 starts where the 63 chunks end, so only page 0 not being full keeps it out.
  const partial = twoSecondPage(0, 0, 63);
  expect(joined(partial, twoSecondPage(1, 126, 3))).toEqual(film(63));
  expect(joined(first, twoSecondPage(1, 130, 3))).toEqual(film(64));
  expect(joined(first, twoSecondPage(2, 256, 1))).toEqual(film(64));
});

test("joined bounds reach a page only once they list a chunk of it", () => {
  // 64 chunks fill page 0 and the 65th starts page 1; with none, no page is reached.
  const reached = [[], twoSecond(0, 1), twoSecond(0, 64), twoSecond(0, 65)].map((b) => [
    reachesPage(b, 0),
    reachesPage(b, 1),
  ]);
  expect(reached).toEqual([
    [false, false],
    [true, false],
    [true, false],
    [true, true],
  ]);
});

test("the chunk covering a moment is found by time, and past the last only once every chunk is listed", () => {
  const moments = [0, 5, 6.9, 7, 12.5, 13, 20.9, 21, 29.9, 30, 100].map((s) => s * SECOND);
  // The chunk whose [start, end) holds each moment, read off the bounds above; before the first
  // chunk, the first.
  expect(moments.map((us) => chunkAt(bounds, us, false))).toEqual([
    0,
    0,
    0,
    1,
    2,
    3,
    3,
    4,
    4,
    undefined,
    undefined,
  ]);
  expect(moments.slice(-2).map((us) => chunkAt(bounds, us, true))).toEqual([4, 4]);
  expect([chunkAt([], 0, true), chunkAt([0], 0, true)]).toEqual([undefined, undefined]);
});

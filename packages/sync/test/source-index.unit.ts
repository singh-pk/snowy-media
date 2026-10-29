// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The source's chunk index (src/source-index.ts), in Chromium: a burst of cuts goes as one page;
// the page still filling goes again as it grows, a full page once, and a burst across pages gives
// each; after a reload only the last page goes again, as after a relay restart; an index out of
// place is refused; and the pages published sign and join into every index cut.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { decodeIndexPage, encodeIndexPage, joinedIndex, type IndexPage } from "../src/chunk-index";
import { generateKeyPair } from "../src/crypto";
import { createSourceIndex, type IndexedCut } from "../src/source-index";

const S = 1_000_000;

// Index i of a film cut every 2 s, whose video takes 1,000 × (i + 1) bytes sealed.
const cut = (i: number): IndexedCut => ({
  index: i,
  startUs: 2 * i * S,
  endUs: 2 * (i + 1) * S,
  bytes: 1_000 * (i + 1),
});

const cuts = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => cut(from + i));

// Every page `next` gives until it gives none.
function drain(index: ReturnType<typeof createSourceIndex>) {
  const pages: IndexPage[] = [];
  for (let page = index.next(); page !== undefined; page = index.next()) pages.push(page);
  return pages;
}

test("a burst of cuts goes as one page, and the page still filling goes again as it grows", () => {
  const index = createSourceIndex();
  const before = drain(index);
  for (const c of cuts(0, 3)) index.add(c);
  const first = drain(index);
  index.add(cut(3));
  const grown = drain(index);

  expect(before).toEqual([]);
  expect(first).toEqual([
    { page: 0, bounds: [0, 2 * S, 4 * S, 6 * S], bytes: [1_000, 2_000, 3_000] },
  ]);
  expect(grown).toEqual([
    { page: 0, bounds: [0, 2 * S, 4 * S, 6 * S, 8 * S], bytes: [1_000, 2_000, 3_000, 4_000] },
  ]);
});

test("a burst across pages gives the full page, then the next, and a full page goes once", () => {
  const index = createSourceIndex();
  for (const c of cuts(0, 63)) index.add(c);
  drain(index);
  for (const c of cuts(63, 66)) index.add(c);
  const across = drain(index);
  index.add(cut(66));
  const after = drain(index);

  // Page 0 lists indexes 0 to 63, from 0 s to 128 s; page 1 starts at index 64, at 128 s.
  expect(across.map((p) => [p.page, p.bounds.length - 1, p.bounds[0], p.bounds.at(-1)])).toEqual([
    [0, 64, 0, 128 * S],
    [1, 2, 128 * S, 132 * S],
  ]);
  expect(across[0]!.bytes.at(-1)).toBe(64_000);
  expect(after).toEqual([
    { page: 1, bounds: [128 * S, 130 * S, 132 * S, 134 * S], bytes: [65_000, 66_000, 67_000] },
  ]);
});

test("after a reload, or with again, only the page listing the newest index goes again", () => {
  const reloaded = createSourceIndex(cuts(0, 66));
  const resumed = drain(reloaded);
  reloaded.again();
  const restarted = drain(reloaded);
  const full = drain(createSourceIndex(cuts(0, 64)));
  const empty = createSourceIndex([]);
  empty.again();
  // A burst into page 1 not published yet when `again` comes: page 0 still goes, full.
  const pending = createSourceIndex(cuts(0, 63));
  drain(pending);
  for (const c of cuts(63, 66)) pending.add(c);
  pending.again();

  const page1 = { page: 1, bounds: [128 * S, 130 * S, 132 * S], bytes: [65_000, 66_000] };
  expect(resumed).toEqual([page1]);
  expect(restarted).toEqual([page1]);
  expect(full.map((p) => [p.page, p.bounds.length - 1])).toEqual([[0, 64]]);
  expect(drain(empty)).toEqual([]);
  expect(drain(pending).map((p) => [p.page, p.bounds.length - 1])).toEqual([
    [0, 64],
    [1, 2],
  ]);
});

test("an index out of place is refused and listed nowhere", () => {
  const index = createSourceIndex([cut(0)]);
  drain(index);
  const thrown = [
    { ...cut(1), index: 2 },
    { ...cut(1), startUs: 2 * S + 1 },
    { ...cut(1), endUs: 2 * S },
    cut(0),
  ].map((c) => {
    try {
      index.add(c);
      return undefined;
    } catch (error) {
      return error;
    }
  });

  expect(thrown).toEqual([
    new RangeError("index 2 is out of place"),
    new RangeError("index 1 is out of place"),
    new RangeError("index 1 is out of place"),
    new RangeError("index 0 is out of place"),
  ]);
  expect(drain(index)).toEqual([]);
});

test("the pages published sign and join into every index cut, with its size", async () => {
  const pair = await generateKeyPair();
  const index = createSourceIndex();
  const held = new Map<number, IndexPage>();

  const state = { cut: 0 };

  // Cut in bursts of 1, 5, 50, 50 and 24 chunks: 130 in all, over three pages.
  for (const burst of [1, 5, 50, 50, 24]) {
    for (const c of cuts(state.cut, state.cut + burst)) index.add(c);
    state.cut += burst;
    const pages = drain(index);
    const encoded = await Promise.all(pages.map((p) => encodeIndexPage(pair, p)));
    const decoded = await Promise.all(
      encoded.map(({ key, bytes }) => decodeIndexPage(pair.publicKey, key, bytes)),
    );
    for (const page of decoded) held.set(page.page, page);
  }

  const joined = joinedIndex((page) => held.get(page));
  expect(held.size).toBe(3);
  expect(joined.bounds).toEqual(Array.from({ length: 131 }, (_, i) => 2 * i * S));
  expect(joined.bytes).toEqual(Array.from({ length: 130 }, (_, i) => 1_000 * (i + 1)));
});

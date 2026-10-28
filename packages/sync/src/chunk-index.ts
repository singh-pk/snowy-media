// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The chunk index (docs/architecture.md#chunk-index): where each chunk cut so far begins and the
// last one ends, so a peer finds the chunk covering a time before it holds that chunk. Chunks
// are as long as the file's keyframes make them, so no peer can work this out alone. The index
// comes in pages of `INDEX_PAGE` chunks, each a signed record (src/signed-record.ts) keyed
// `index/<page>@<n>` for the n chunks it lists. A page only grows until it is full, so a peer
// keeps the one listing the most, and a full page never travels again.

import { isCount, isRecord } from "./chat";
import type { Bytes } from "./crypto";
import {
  checkRecordSig,
  InvalidRecordError,
  onlyFields,
  parseRecord,
  signRecord,
} from "./signed-record";

/** How many chunks a page of the index lists once it is full. */
const INDEX_PAGE = 64;

export type IndexPage = {
  /** Which page: it lists chunks from `page × INDEX_PAGE`. */
  page: number;
  /**
   * Chunk boundaries in microseconds, increasing: the page's `i`th chunk is
   * `[bounds[i], bounds[i + 1])`, as each chunk ends where the next begins. One list serves every
   * track, since an index is the same time range in each.
   */
  bounds: number[];
};

const FIELDS = new Set(["page", "bounds"]);
const DOMAIN = "snowy index v1";

// The object key of a page listing `count` chunks.
const pageKey = (page: number, count: number) => `index/${page}@${count}`;

/** How many chunks a page lists. */
export const listed = ({ bounds }: IndexPage) => bounds.length - 1;

/** Whether `bounds`, as `joinedBounds` gives them, list a chunk of `page`: no page before it is missing. */
export const reachesPage = (bounds: number[], page: number) =>
  bounds.length - 1 > page * INDEX_PAGE;

// A page in canonical shape: at least one chunk and at most a full page, each with a length.
function checkPage(value: unknown): IndexPage {
  if (!isRecord(value)) throw new InvalidRecordError("not an object");
  onlyFields(value, FIELDS);

  const { page, bounds } = value;
  if (!isCount(page, 0)) throw new InvalidRecordError("bad page");
  const sized = Array.isArray(bounds) && bounds.length >= 2 && bounds.length <= INDEX_PAGE + 1;
  if (!sized) throw new InvalidRecordError("bad bounds");
  const checked: number[] = [];

  for (const bound of bounds) {
    const previous = checked.at(-1) ?? -1;
    if (!isCount(bound, 0) || bound <= previous) throw new InvalidRecordError("bad bounds");
    checked.push(bound);
  }

  return { page, bounds: checked };
}

/**
 * Signs a page of the index with the session key. Returns its object key and bytes. Throws an
 * `InvalidRecordError` for a malformed one.
 */
export async function encodeIndexPage(session: CryptoKeyPair, page: IndexPage) {
  const canonical = checkPage(page);
  const bytes = await signRecord(session, DOMAIN, canonical);
  return { key: pageKey(canonical.page, listed(canonical)), bytes };
}

/**
 * Checks that a page of the index is the page, listing as many chunks, that its object key
 * names, is well formed and signed by the session key, then reads it. Rejects with an
 * `InvalidRecordError` for anything else.
 */
export async function decodeIndexPage(sessionKey: CryptoKey, key: string, bytes: Bytes) {
  const { sig, fields } = parseRecord(bytes);
  const page = checkPage(fields);
  if (key !== pageKey(page.page, listed(page))) throw new InvalidRecordError("another page");
  await checkRecordSig(sessionKey, DOMAIN, sig, page);
  return page;
}

/**
 * The bounds of every chunk listed without a gap from the first: page 0, then each page `pageOf`
 * gives that starts where the one before ends, up to the first that isn't full.
 */
export function joinedBounds(pageOf: (page: number) => IndexPage | undefined) {
  const bounds: number[] = [];

  for (let number = 0, page = pageOf(0); page !== undefined; page = pageOf(++number)) {
    if (number > 0 && page.bounds[0] !== bounds.at(-1)) break;
    // copy: each page's bounds once, into one list, without repeating where one meets the next.
    bounds.push(...(number === 0 ? page.bounds : page.bounds.slice(1)));
    if (listed(page) < INDEX_PAGE) break;
  }

  return bounds;
}

/**
 * The index of the chunk covering a moment, or undefined while it isn't listed. A moment before
 * the first chunk is covered by it, and one past the last, once `ended` says every chunk is
 * listed, by the last.
 */
export function chunkAt(bounds: readonly number[], us: number, ended: boolean) {
  const count = bounds.length - 1;
  if (count < 1) return undefined;
  let low = 0;
  let high = count;

  // The first chunk starting after `us`.
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (bounds[middle]! <= us) low = middle + 1;
    else high = middle;
  }

  const index = Math.max(0, low - 1);
  return us < bounds[count]! || ended ? index : undefined;
}

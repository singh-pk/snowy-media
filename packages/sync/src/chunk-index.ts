// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The chunk index (docs/architecture.md#chunk-index), so a peer finds the chunk covering a time,
// and what asking for it costs, before it holds it: the file's keyframes set each chunk's length,
// so no peer can work this out alone. A page only grows until it is full, so a peer keeps the one
// listing the most, and a full page never travels again.

import { isCount, isRecord } from "./chat";
import type { Bytes } from "./crypto";
import {
  checkRecordSig,
  InvalidRecordError,
  onlyFields,
  parseRecord,
  signRecord,
} from "./signed-record";

const INDEX_PAGE = 64;

export type IndexPage = {
  /** Which page: it lists chunks from `page × INDEX_PAGE`. */
  page: number;
  /**
   * In microseconds, increasing: the page's `i`th chunk is `[bounds[i], bounds[i + 1])`. One list
   * serves every track, since an index is the same time range in each.
   */
  bounds: number[];
  /** The sealed size of the page's `i`th chunk of video, in bytes. */
  bytes: number[];
};

export type JoinedIndex = Pick<IndexPage, "bounds" | "bytes">;

const FIELDS = new Set(["page", "bounds", "bytes"]);
const DOMAIN = "snowy index v1";

const pageKey = (page: number, count: number) => `index/${page}@${count}`;

export const listed = ({ bounds }: IndexPage) => bounds.length - 1;

/**
 * Whether `bounds`, as `joinedIndex` gives them, list a chunk of `page`, so no page before it is
 * missing.
 */
export const reachesPage = (bounds: number[], page: number) =>
  bounds.length - 1 > page * INDEX_PAGE;

function checkBounds(bounds: unknown) {
  const sized = Array.isArray(bounds) && bounds.length >= 2 && bounds.length <= INDEX_PAGE + 1;
  if (!sized) throw new InvalidRecordError("bad bounds");
  const checked: number[] = [];

  for (const bound of bounds) {
    const previous = checked.at(-1) ?? -1;
    if (!isCount(bound, 0) || bound <= previous) throw new InvalidRecordError("bad bounds");
    checked.push(bound);
  }

  return checked;
}

function checkSizes(bytes: unknown, count: number) {
  if (!Array.isArray(bytes) || bytes.length !== count) throw new InvalidRecordError("bad bytes");
  const checked: number[] = [];

  for (const size of bytes) {
    if (!isCount(size, 1)) throw new InvalidRecordError("bad bytes");
    checked.push(size);
  }

  return checked;
}

function checkPage(value: unknown): IndexPage {
  if (!isRecord(value)) throw new InvalidRecordError("not an object");
  onlyFields(value, FIELDS);

  const { page } = value;
  if (!isCount(page, 0)) throw new InvalidRecordError("bad page");
  const bounds = checkBounds(value.bounds);
  return { page, bounds, bytes: checkSizes(value.bytes, bounds.length - 1) };
}

/**
 * Signs an index page with the session key. Resolves to its object key and bytes. Rejects with an
 * `InvalidRecordError` for a malformed page.
 */
export async function encodeIndexPage(session: CryptoKeyPair, page: IndexPage) {
  const canonical = checkPage(page);
  const bytes = await signRecord(session, DOMAIN, canonical);
  return { key: pageKey(canonical.page, listed(canonical)), bytes };
}

/**
 * Rejects with an `InvalidRecordError` unless the page is the one its key names, listing as many
 * chunks, well formed and signed by the session key.
 */
export async function decodeIndexPage(sessionKey: CryptoKey, key: string, bytes: Bytes) {
  const { sig, fields } = parseRecord(bytes);
  const page = checkPage(fields);
  if (key !== pageKey(page.page, listed(page))) throw new InvalidRecordError("another page");
  await checkRecordSig(sessionKey, DOMAIN, sig, page);
  return page;
}

/**
 * Every chunk listed without a gap from the first, with its size: page 0, then each page
 * `pageOf` gives that starts where the one before ends, up to the first that isn't full.
 */
export function joinedIndex(pageOf: (page: number) => IndexPage | undefined): JoinedIndex {
  const joined: JoinedIndex = { bounds: [], bytes: [] };

  for (let number = 0, page = pageOf(0); page !== undefined; page = pageOf(++number)) {
    if (number > 0 && page.bounds[0] !== joined.bounds.at(-1)) break;
    // copy: each page's bounds once, into one list, without repeating where one meets the next.
    joined.bounds.push(...(number === 0 ? page.bounds : page.bounds.slice(1)));
    // copy: each page's sizes once, into one list.
    joined.bytes.push(...page.bytes);
    if (listed(page) < INDEX_PAGE) break;
  }

  return joined;
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

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The source's chunk index (docs/architecture.md#chunk-index): each page built from the indexes
// it has cut, and which to publish next. Pages are published when the stream will take more, so
// a burst of cuts goes as one update of the page still filling, and a full page goes once.

import { INDEX_PAGE, type IndexPage } from "./chunk-index";
import type { IndexedCut } from "./source-cut";

export type SourceIndexOptions = {
  /** After a reload, the indexes cut before it, in order. */
  kept: readonly IndexedCut[];
  /** How many of them the source's own pages list, joined from the first as `joinedIndex` joins. */
  published: number;
};

/**
 * The source's index, after a reload carrying on from what it published: every page listing an
 * index past `published` goes, and the page listing the newest index goes again even when full,
 * since its last update may not have gone.
 */
export function createSourceIndex(from: SourceIndexOptions = { kept: [], published: 0 }) {
  const bounds: number[] = [];
  const sizes: number[] = [];
  const state = { sentCount: 0 };

  /** Lists the next index. Throws a `RangeError` unless it follows the last, with a length. */
  function add(cut: IndexedCut) {
    const last = bounds.at(-1);
    const follows = cut.index === sizes.length && (last === undefined || cut.startUs === last);
    if (!follows || cut.endUs <= cut.startUs)
      throw new RangeError(`index ${cut.index} is out of place`);
    if (last === undefined) bounds.push(cut.startUs);
    bounds.push(cut.endUs);
    sizes.push(cut.bytes);
  }

  /** The page listing the newest index goes again with the next `next`, as after a relay restart. */
  function again() {
    const start = Math.floor((sizes.length - 1) / INDEX_PAGE) * INDEX_PAGE;
    state.sentCount = Math.min(state.sentCount, Math.max(0, start));
  }

  /**
   * The oldest page listing an index not yet published, as far as it now goes, or undefined when
   * every index is. A full page comes once.
   */
  function next(): IndexPage | undefined {
    const first = state.sentCount;
    if (first === sizes.length) return undefined;
    const page = Math.floor(first / INDEX_PAGE);
    const start = page * INDEX_PAGE;
    const end = Math.min(sizes.length, start + INDEX_PAGE);
    state.sentCount = end;
    // copy: a page's own lists, signed and published while these grow.
    return { page, bounds: bounds.slice(start, end + 1), bytes: sizes.slice(start, end) };
  }

  for (const cut of from.kept) add(cut);
  state.sentCount = from.published;
  again();
  return { add, again, next };
}

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The source's chunk index (docs/architecture.md#chunk-index): each page built from the indexes
// it has cut, and which to publish next. Pages are published when the stream will take more, so
// a burst of cuts goes as one update of the page still filling, and a full page goes once.

import { INDEX_PAGE, type IndexPage } from "./chunk-index";

/** An index cut in every track: `[startUs, endUs)`, its video chunk `bytes` long sealed. */
export type IndexedCut = { index: number; startUs: number; endUs: number; bytes: number };

/**
 * The source's index, starting from `kept`, the indexes cut before a reload, in order: their
 * last page goes again, since it may not have gone after its last cut.
 */
export function createSourceIndex(kept: readonly IndexedCut[] = []) {
  const bounds: number[] = [];
  const sizes: number[] = [];
  // How many chunks are listed in what has been published, counted from the first.
  const state = { published: 0 };

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
    state.published = Math.min(state.published, Math.max(0, start));
  }

  /**
   * The oldest page listing an index not yet published, as far as it now goes, or undefined when
   * every index is. A full page comes once.
   */
  function next(): IndexPage | undefined {
    const from = state.published;
    if (from === sizes.length) return undefined;
    const page = Math.floor(from / INDEX_PAGE);
    const start = page * INDEX_PAGE;
    const end = Math.min(sizes.length, start + INDEX_PAGE);
    state.published = end;
    // copy: a page's own lists, signed and published while these grow.
    return { page, bounds: bounds.slice(start, end + 1), bytes: sizes.slice(start, end) };
  }

  for (const cut of kept) add(cut);
  state.published = sizes.length;
  again();
  return { add, again, next };
}

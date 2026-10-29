// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Skipping an operation (docs/architecture.md#applying): an operation that doesn't fit the
// document is skipped as it is checked, before anything changes, and recorded with the kind of
// reason the design names, so every peer skips the same operations for the same reasons.

import { InvalidError } from "./schema";
import { frameFlicks, type Ratio } from "./time";

/** Why an operation was skipped: the kinds docs/architecture.md#applying names. */
export type SkipReason = "malformed" | "stale" | "structural" | "unsupported" | "waiting";

/** `index` is the skipped operation's place in its batch. */
export type Skip = { index: number; reason: SkipReason; detail: string };

export class Skipped extends Error {
  constructor(
    readonly reason: SkipReason,
    detail: string,
  ) {
    super(detail);
    this.name = "Skipped";
  }
}

export function skip(reason: SkipReason, detail: string): never {
  throw new Skipped(reason, detail);
}

/** `check(value)`, or a skip for a value that doesn't fit. */
export function checked<T>(check: (value: unknown, at: string) => T, value: unknown) {
  try {
    return check(value, "");
  } catch (error) {
    if (error instanceof InvalidError) skip("malformed", error.message);
    throw error;
  }
}

export function checkRate(rate: Ratio) {
  try {
    frameFlicks(rate);
  } catch {
    skip("malformed", `a frame at ${rate[0]}/${rate[1]} fps is not whole flicks`);
  }
}

/**
 * `change()`, skipped as malformed when it would take a time past the safe integers: storyline
 * and layout refuse those with a RangeError, before changing anything.
 */
export function guarded<T>(change: () => T) {
  try {
    return change();
  } catch (error) {
    if (error instanceof RangeError) skip("malformed", error.message);
    throw error;
  }
}

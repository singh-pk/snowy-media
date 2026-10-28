// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The render worker's queue of decoded frames, in presentation order whatever order the
// decoder emits them in, and bounded by the bytes they hold, so memory stays bounded at any
// resolution (AGENTS.md rule 4).

/** What the queue needs of a frame: a VideoFrame, or a stand-in in a test. */
export interface QueuedFrame {
  /** The presentation time, in microseconds. */
  readonly timestamp: number;
  close(): void;
}

/** A queue that holds frames of up to `budget` bytes in all, `size(frame)` bytes each. */
export function createFrameQueue<F extends QueuedFrame>(
  budget: number,
  size: (frame: F) => number,
) {
  const frames: F[] = [];
  const sizes: number[] = [];
  let bytes = 0;

  /** Takes ownership of `frame`. */
  function push(frame: F) {
    // Frames nearly always arrive in order, so the search starts from the end.
    // Shifted in place, not spliced, so nothing is allocated per frame.
    let at = frames.length;
    const n = size(frame);

    for (let before = frames[at - 1]; before && before.timestamp > frame.timestamp; at--) {
      frames[at] = before;
      sizes[at] = sizes[at - 1] ?? 0;
      before = frames[at - 2];
    }

    frames[at] = frame;
    sizes[at] = n;
    bytes += n;
  }

  // Drops the first `n` frames, without closing them.
  function shift(n: number) {
    for (let i = 0; i < n; i++) bytes -= sizes[i] ?? 0;
    frames.copyWithin(0, n);
    sizes.copyWithin(0, n);
    frames.length -= n;
    sizes.length -= n;
  }

  /**
   * Closes the frames due at `time` (microseconds) but the latest: they would never be shown
   * in time, as at a seek's target.
   */
  function drop(time: number) {
    let due = 0;
    while (due < frames.length && (frames[due]?.timestamp ?? 0) <= time) due++;
    if (due < 2) return;
    for (let i = 0; i < due - 1; i++) frames[i]?.close();
    shift(due - 1);
  }

  /**
   * The latest frame due at `time` (microseconds), which the caller then owns, after closing
   * the earlier ones: they were never shown in time. Undefined while no frame is due.
   */
  function take(time: number) {
    drop(time);
    const frame = frames[0];
    if (!frame || frame.timestamp > time) return undefined;
    shift(1);
    return frame;
  }

  /** The earliest frame, still the queue's. */
  const first = (): F | undefined => frames[0];

  const count = () => frames.length;

  /** The earliest frame, which the caller then owns. */
  function next() {
    const frame = frames[0];
    if (frame) shift(1);
    return frame;
  }

  /** Whether the queue holds `budget` bytes or more, so decoding should wait. */
  function full() {
    return bytes >= budget;
  }

  /** Closes and drops every frame. */
  function clear() {
    for (const frame of frames) frame.close();
    frames.length = 0;
    sizes.length = 0;
    bytes = 0;
  }

  return { push, drop, take, next, first, count, full, clear };
}

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// How far a video decoder has decoded, whatever order it emits frames in. A packet that makes
// no frame (a VP8 alt-ref frame), or whose frame is never emitted, stops being waited for once a
// frame fed far enough after it comes out (docs/architecture.md#video-output).

/**
 * How many packets, in decode order, a frame may be fed after one whose frame comes out after
 * it: how far the stream reorders. Twice the 16 frames of an H.264 or HEVC decoded picture
 * buffer, as a margin; a stream that reorders further, or stores a field a packet, may show a
 * frame late or drop it, but never holds play.
 */
const HELD = 32;

export function createDecodeTracker(held = HELD) {
  // In the order fed.
  const stamps: number[] = [];
  const numbers: number[] = [];
  const state = {
    latest: -Infinity,
    // The dts of the last packet fed: every packet still to come is due after it.
    fed: -Infinity,
    count: 0,
  };

  /**
   * A packet with timestamp `timestamp` and dts `dts` (microseconds) given to the decoder;
   * `frame` is false if it makes no frame.
   */
  function feed(timestamp: number, dts: number, frame: boolean) {
    state.fed = dts;
    const number = state.count++;
    if (!frame) return;
    stamps.push(timestamp);
    numbers.push(number);
  }

  /**
   * A frame with timestamp `timestamp` out. Packets fed more than `held` before its own will
   * make no frame, and are no longer waited for.
   */
  function out(timestamp: number) {
    state.latest = Math.max(state.latest, timestamp);
    const at = stamps.indexOf(timestamp);
    // A frame not waited for says nothing of how far the stream reorders.
    if (at < 0) return;
    const oldest = (numbers[at] ?? 0) - held;
    let kept = 0;

    // In place, so nothing is allocated per frame.
    for (let i = 0; i < stamps.length; i++) {
      const number = numbers[i] ?? 0;
      if (i === at || number < oldest) continue;
      stamps[kept] = stamps[i] ?? 0;
      numbers[kept] = number;
      kept++;
    }

    stamps.length = kept;
    numbers.length = kept;
  }

  /** The decoder is flushed: every frame is out, and no packet is to come. */
  function end() {
    stamps.length = 0;
    numbers.length = 0;
    state.fed = Infinity;
  }

  /**
   * The time, in microseconds, up to which every frame is decoded: the latest timestamp out,
   * but no later than just before the earliest packet whose frame is still to come, or the
   * last packet fed. -Infinity before the first frame. It never goes back while the dts of the
   * packets fed rises.
   */
  function decodedTo() {
    let earliest = Infinity;
    // Indexed: an iterator would allocate on every event.
    for (let i = 0; i < stamps.length; i++) earliest = Math.min(earliest, stamps[i] ?? Infinity);
    return Math.min(state.latest, earliest - 1, state.fed);
  }

  return { feed, out, end, decodedTo };
}

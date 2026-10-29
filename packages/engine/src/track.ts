// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The render worker's video track (docs/architecture.md#compositions): one output per clip, each reading
// the packet ring on from where the one before stopped. Times here are the clock's; each output
// keeps its file's.

import { endOf, startOf } from "./composition";
import type { createCompositor } from "./compositor";
import type { VideoClip } from "./protocol";
import { createConsumer } from "./ring";
import { createVideoOutput } from "./video";
import type { createWasmVideo } from "./wasm-video";

type Output = ReturnType<typeof createVideoOutput>;
type Track = ReturnType<typeof createState>;

export interface TrackOptions {
  compositor: ReturnType<typeof createCompositor>;
  wasm: ReturnType<typeof createWasmVideo>;
  /** Runs as decoding moves (src/video.ts), and once the media worker blocks while `watch`ed. */
  changed: () => void;
  /** Runs as the ring frees room for a waiting producer, and as it closes (src/ring.ts). */
  freed: () => void;
}

function createState(ring: SharedArrayBuffer, clips: VideoClip[], options: TrackOptions) {
  return {
    ring,
    clips,
    // copy: the options' few fields, once a play.
    ...options,
    consumer: createConsumer(ring, options.changed, options.freed),
    outputs: clips.map((): Output | undefined => undefined),
    // The clip whose output reads the ring, and the first the clock has not passed.
    reading: -1,
    current: 0,
    black: false,
    decoded: -Infinity,
    closed: false,
  };
}

function close(t: Track, k: number) {
  t.outputs[k]?.close();
  t.outputs[k] = undefined;
}

async function readClips(t: Track) {
  const { ring, compositor, wasm, consumer, changed } = t;

  for (const [k, clip] of t.clips.entries()) {
    const output = createVideoOutput(ring, clip.params, {
      compositor,
      wasm,
      consumer,
      changed,
      from: clip.in,
    });
    t.outputs[k] = output;
    t.reading = k;
    // Passed before it was read: it reads on to its CUT record, as `pass` has an output do.
    if (k < t.current) output.pass();
    await output.done;
    // Closed, or stopped short of its last record as the producer failed.
    if (t.closed || !output.read()) return;
    if (k < t.current) close(t, k);
  }
}

// The clip at or after `time`: the first not passed that ends after it, or clips.length.
function clipAt(t: Track, time: number) {
  for (let k = t.current; k < t.clips.length; k++) {
    const clip = t.clips[k];
    if (clip && time < endOf(clip)) return k;
  }

  return t.clips.length;
}

// An output still reading when the clock passes its clip reads on to its CUT record, so the next
// clip's output starts where it should, and closes then.
function pass(t: Track, k: number) {
  const output = t.outputs[k];
  if (output?.read()) close(t, k);
  else output?.pass();
}

// Shows what is due at `at`; returns whether a frame went up, black counting as one.
function present(t: Track, at: number) {
  const k = clipAt(t, at);

  while (t.current < k) {
    pass(t, t.current);
    t.current++;
  }

  const clip = t.clips[k];

  if (!clip || at < startOf(clip)) {
    if (!t.black) t.compositor.clear();
    t.black = true;
    if (clip) void t.outputs[k]?.prepare(clip.in);
    return true;
  }

  t.black = false;
  const drawn = t.outputs[k]?.present(at - clip.offset) ?? false;
  const next = t.clips[k + 1];
  if (next) void t.outputs[k + 1]?.prepare(next.in);
  return drawn;
}

// The clip that shows `time`, or -1 for black. An index, as it runs on every animation frame.
function shownAt(t: Track, time: number) {
  const k = clipAt(t, time);
  const clip = t.clips[k];
  return clip && time >= startOf(clip) ? k : -1;
}

// Whether `has` holds of the output that shows `time`, at its time in the file; black is up at once.
function shows(t: Track, time: number, has: (output: Output, at: number) => boolean) {
  const k = shownAt(t, time);
  const clip = t.clips[k];
  const output = t.outputs[k];
  if (!clip) return t.black;
  return Boolean(output && has(output, time - clip.offset));
}

const isCurrent = (output: Output, at: number) => output.current(at);
const hasReached = (output: Output, at: number) => output.reached(at);

function decodedTo(t: Track) {
  const output = t.outputs[t.reading];
  const clip = t.clips[t.reading];
  if (output && clip) t.decoded = Math.max(t.decoded, output.decodedTo() + clip.offset);
  return t.decoded;
}

/**
 * The video of `clips`, read in turn from `ring`, each shown from `in` to `out` with black between
 * and around them. `done` resolves once the last clip is decoded, the producer has failed (it
 * reports why itself) or the track is closed, and rejects if decoding fails.
 */
export function createTrack(ring: SharedArrayBuffer, clips: VideoClip[], options: TrackOptions) {
  const t = createState(ring, clips, options);
  const reading = () => t.outputs[t.reading];

  return {
    done: readClips(t),
    present: (at: number) => present(t, at),
    /** Whether black is on screen at `time`, or a frame with none due by then still going up. */
    current(time: number) {
      return shows(t, time, isCurrent);
    },
    /** Whether the frame due at `time` is the one on screen, or black is, between clips. */
    reached(time: number) {
      return shows(t, time, hasReached);
    },
    /** Moves a paused play on to `to`, later in the same clip, as a scrub does. */
    moveTo(to: number) {
      const k = shownAt(t, to);
      const clip = t.clips[k];
      if (clip) t.outputs[k]?.moveTo(to - clip.offset);
    },
    decodedTo: () => decodedTo(t),
    ended: () => t.reading === clips.length - 1 && Boolean(reading()?.ended()),
    full: () => Boolean(reading()?.full()),
    starved: () => Boolean(reading()?.starved()),
    blocked: () => t.consumer.producerWaiting(),
    /** Call before reading `blocked`, so a block just after that read still runs `changed`. */
    watch: () => t.consumer.watch(),
    close() {
      t.closed = true;
      for (const k of clips.keys()) close(t, k);
      t.consumer.close();
    },
  };
}

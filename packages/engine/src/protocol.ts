// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The messages between the engine on the main thread and its workers, and the types they
// carry that the public API shares.

import type { VideoParams } from "./codec";

/** A platform feature the engine needs (AGENTS.md rule 2). */
export type PlatformFeature =
  | "cross-origin-isolation"
  | "wasm-simd"
  | "wasm-threads"
  | "audio-worklet"
  | "offscreen-canvas"
  | "webgpu"
  | "webcodecs"
  | "webgpu-external-texture";

export type Missing = [feature: PlatformFeature, reason: string];

// After init, the render worker plays the video packets in `ring` (src/ring.ts), timed by the
// clock in PCM ring `pcm` (src/pcm.ts), until it stops. It plays from `from` (microseconds),
// and of the frames before it shows only the last. A clip's play (`window`) shows frames only
// from `in` to `out`, black around them, and its clock may start earlier, at `start`.
// An error is reported once, with the play's `id`, and it stops. Until it has drawn a frame by
// the running clock (`shown`, the last report), it reports each change in how far decoding is:
// a quarter second or all of it (`ahead`), or no further while the media worker is blocked
// (`stuck`), so the main thread starts audio with video ready (src/index.ts).
export type ToRender =
  | { type: "init"; canvas: OffscreenCanvas }
  | {
      type: "play";
      id: number;
      ring: SharedArrayBuffer;
      params: VideoParams;
      pcm: SharedArrayBuffer;
      from: number;
      window?: { start: number; in: number; out: number };
    }
  // The play `id`, paused, goes on to `to` (microseconds) by decoding on: a scrub forward.
  | { type: "scrub"; id: number; to: number }
  | { type: "stop" }
  // Stops what plays and clears the canvas: another file opens.
  | { type: "clear" };

export type FromRender =
  | { type: "ready" }
  | { type: "unsupported"; missing: Missing }
  | {
      type: "video";
      id: number;
      ahead: boolean;
      stuck: boolean;
      // A frame is on screen, whether or not the clock runs.
      drawn: boolean;
      shown: boolean;
      // The last target (microseconds) whose frame due is on screen, or -1.
      reached: number;
    }
  | { type: "error"; id: number; message: string };

/** A stream of a media file. `id` is its index in the file; `codec` is FFmpeg's codec name. */
export type Track =
  | { id: number; kind: "video"; codec: string; width: number; height: number }
  | { id: number; kind: "audio"; codec: string; sampleRate: number; channels: number }
  | { id: number; kind: "subtitle" | "data" | "attachment"; codec: string };

export interface Opened {
  info: MediaInfo;
  video: Record<number, VideoParams>;
  /**
   * The times of its keyframes in the demuxer's index, in microseconds, and of the index's last
   * entry, so how far it is known; none and -Infinity without one.
   */
  index: Record<number, { keyframes: number[]; end: number }>;
}

export interface MediaInfo {
  /** FFmpeg's names for the container format, such as "mov,mp4,m4a,3gp,3g2,mj2". */
  format: string;
  /** In seconds, unless the file does not say. */
  duration: number | undefined;
  tracks: Track[];
}

// `id` pairs each reply with its request. A demux writes the packets of `streams` into `ring`
// (src/ring.ts) from the keyframe due at or before `from` (microseconds), and with `audio`
// decodes that stream into PCM ring `pcm` (src/pcm.ts), resampled to its rate and channels.
// A play's PCM ring keeps its clock, so it comes without `audio` too: the media worker writes
// how far the packets reach into it, and that no audio comes. Unless it fails or the ring closes
// first, it sends `buffered` once before it replies: at `preroll` frames, a full ring, all of
// the audio, or at once without audio. A clip's demux (`clip`) writes no packet or audio past
// `until`, and its clock starts at `start`, before `from` in a gap before the clip, silent up
// to the clip's audio; past `until` the clock runs on to `end`. It replies once it has written
// all the audio and the END record, or a consumer has closed its ring. On an error it ends the
// ring with FAILED and replies with the error, its only report.
export type ToMedia =
  | { type: "open"; id: number; file: File }
  | {
      type: "demux";
      id: number;
      ring: SharedArrayBuffer;
      streams: number[];
      from: number;
      pcm?: SharedArrayBuffer;
      // Its audio before `from` is dropped. Needs `pcm`.
      audio?: { stream: number; preroll: number };
      // Needs `pcm`.
      clip?: { start: number; until: number; end: number };
    };

export type FromMedia =
  | ({ type: "opened"; id: number } & Opened)
  | { type: "buffered"; id: number }
  | { type: "demuxed"; id: number }
  | { type: "error"; id: number; message: string };

// The render worker's decoders in the video decode worker (src/video.worker.ts), each by its id,
// talk through two rings (src/ring.ts) sent once at the start, with no message per packet or
// frame. A decoder's packets stay in its play's packet ring, sent (`packets`) before it opens:
// the decode worker copies each out itself, so only where it is crosses. To the worker, a
// decoder opens for a play's video stream that one of VIDEO_MODULES decodes, from its exported
// codec parameters, then takes packets in decoding order (timestamps in its time base), one
// packet ring record at a time, a flush at the stream's end, and a close; and a frame goes back,
// by its module, once uploaded or dropped, whether its decoder is open or not. From the worker
// come each packet ring record taken, which the render worker then frees, each decoded frame,
// each packet decoded, the flush done, and a decoder's first error, after which it decodes
// nothing. A module's memory, which frames are read from, comes by message once it loads,
// before any of its frames.
export type ToVideo =
  | { type: "start"; to: SharedArrayBuffer; from: SharedArrayBuffer }
  | { type: "packets"; id: number; ring: SharedArrayBuffer };
export type FromVideo = { type: "memory"; module: number; memory: WebAssembly.Memory };

/** The FFmpeg modules that decode video, by their index in records. */
export const VIDEO_MODULES = ["video", "video-ext"] as const;

/**
 * A record's kind, in the low KIND_BITS of its stream, and its decoder's id in the rest. To the
 * worker: `open`, its module in the duration, its time base in pts and dts, the parameters as
 * payload; `packet`, a record of the decoder's packet ring, with its packet's header and its
 * place there (PLACE) as payload; `flush` and `close`; and `release`, of the frame in the flags
 * from the module in the duration, which the pts says is packed (1) or not (0).
 */
export const TO_VIDEO = { open: 0, packet: 1, flush: 2, close: 3, release: 4 } as const;
/**
 * From the worker: `frame`, its FRAME payload; `decoded`; `flushed`; `failed`, its message; and
 * `taken`, a packet ring record copied out.
 */
export const FROM_VIDEO = { frame: 0, decoded: 1, flushed: 2, failed: 3, taken: 4 } as const;
export const KIND_BITS = 3;

/**
 * A packet record's payload, in 32-bit words: where its packet ring record's payload starts and
 * its size, and which PART of its packet it is (src/ring.ts).
 */
export const PLACE = { start: 0, size: 1, part: 2, bytes: 12 } as const;

/**
 * A frame record's payload, in 32-bit words, then its timestamp as a float64 (`timestamp`, an
 * index in 64-bit words): FFmpeg's frame, left where it is in the shared memory of the module
 * that decoded it until it goes back, as its AVFrame or the buffer a frame stored bottom row
 * first is packed into (`packed`); its format, an index in PIXEL_FORMATS; its size; the bytes it
 * holds; and from `layout` on, where each of its `planes` starts in the memory and its stride.
 */
export const FRAME = {
  frame: 0,
  packed: 1,
  module: 2,
  format: 3,
  codedWidth: 4,
  codedHeight: 5,
  displayWidth: 6,
  size: 7,
  planes: 8,
  layout: 9,
  // In 64-bit words: bytes 72 to 79, after the layout's 4 planes.
  timestamp: 9,
  bytes: 80,
} as const;

/** The formats a frame may have: those sny_to_video_format makes, by their index in records. */
export const PIXEL_FORMATS = [
  "I420",
  "I420P10",
  "I420P12",
  "I420A",
  "I420AP10",
  "I422",
  "I422P10",
  "I422P12",
  "I422A",
  "I422AP10",
  "I444",
  "I444P10",
  "I444P12",
  "I444A",
  "I444AP10",
  "NV12",
  "RGBA",
  "RGBX",
  "BGRA",
  "BGRX",
] as const;

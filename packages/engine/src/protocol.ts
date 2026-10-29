// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The messages between the engine on the main thread and its workers, and the types they
// carry that the public API shares. Which thread does what: docs/architecture.md#threads.

import type { VideoParams } from "./codec";
import type { Clip } from "./composition";

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

/**
 * A clip of video the render worker plays: its packets, of a stream with `params`, start at a
 * keyframe before `in`, and it is shown from `in` to `out` in its file's time, `offset` later on
 * the clock, all in microseconds. Of the frames before `in`, only the last, the one due then, is
 * shown.
 */
export interface VideoClip {
  params: VideoParams;
  in: number;
  out: number;
  offset: number;
}

/**
 * From the main thread to the render worker. After `init`, each `play` plays the video packets in
 * `ring` (src/ring.ts), timed by the clock in the PCM ring `pcm` (src/pcm.ts), until `stop`,
 * `clear` or the next `play`. A play's first error stops it and is reported once, with its `id`.
 */
export type ToRender =
  | { type: "init"; canvas: OffscreenCanvas }
  | {
      type: "play";
      id: number;
      ring: SharedArrayBuffer;
      pcm: SharedArrayBuffer;
      /** Where the clock starts, in microseconds. */
      from: number;
      /**
       * The clips whose packets `ring` holds, in turn, each ended by a CUT record, or the last by
       * the END record, with black between and around them on the clock. A file plays as one
       * clip, from where it starts to the end, at an offset of 0.
       */
      clips: VideoClip[];
    }
  /**
   * Moves the paused play `id` on to `to` (microseconds) by decoding further: a scrub forward.
   * The main thread starts a new play for a scrub back or past a keyframe.
   */
  | { type: "scrub"; id: number; to: number }
  | { type: "stop" }
  /** Stops what plays and leaves the canvas black, as when another file opens. */
  | { type: "clear" };

/** From the render worker to the main thread. */
export type FromRender =
  | { type: "ready" }
  | { type: "unsupported"; missing: Missing }
  | {
      type: "video";
      id: number;
      /**
       * Decoding has reached a quarter second past where the play starts, or the stream's end, so
       * the main thread may start audio (src/playback.ts). Updated only until `shown`.
       */
      ahead: boolean;
      /**
       * The media worker is blocked, on a full PCM ring or packet ring, and video gets no further,
       * so the main thread starts audio without waiting for `ahead`. Updated only until `shown`.
       */
      stuck: boolean;
      /** The GPU has drawn the frame due where the play starts, whether or not the clock runs. */
      drawn: boolean;
      /** The clock runs and the frame due by it is on screen. Once true, it stays true. */
      shown: boolean;
      /**
       * The last target, where the play starts or a scrub moved it to, in microseconds, whose due
       * frame the GPU has drawn; -1 before the first.
       */
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
   * By video stream id: the times of the stream's keyframes in the demuxer's index, in
   * microseconds, and the time of the index's last entry (`end`), up to which the index is known.
   * A stream without an index has no keyframes and an `end` of -Infinity.
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

/**
 * From the main thread to the media worker. Each reply carries the `id` of its request. An `open`
 * replies `opened`. A `demux` or a `track` replies `demuxed` once it has written the packet ring's
 * END record and all the audio (or the PCM ring's consumer has closed that ring), or once the
 * packet ring's consumer has closed it; on an error it ends the packet ring with FAILED and replies
 * `error`, its only report.
 */
export type ToMedia =
  | { type: "open"; id: number; file: File }
  | {
      type: "demux";
      id: number;
      /** The packet ring (src/ring.ts) that the packets of `streams` are written into. */
      ring: SharedArrayBuffer;
      streams: number[];
      /** Microseconds: packets are written from the keyframe due at or before it. */
      from: number;
      /**
       * The play's PCM ring (src/pcm.ts), which holds its clock, so it comes without `audio` too.
       * The media worker writes into it how far the packets reach and, without `audio`, that no
       * audio comes. With it, `buffered` is sent once before the reply, unless the demux fails or
       * the ring closes first; without `audio`, it is sent at once.
       */
      pcm?: SharedArrayBuffer;
      /**
       * The audio stream to decode into `pcm`, resampled to its rate and channels; it must not
       * be one of `streams`. Its audio before `from` is dropped. `buffered` is sent once `pcm`
       * holds `preroll` frames, is full or has all the audio. Needs `pcm`.
       */
      audio?: { stream: number; preroll: number };
    }
  | {
      /**
       * Reads a composition's clips of the open file in turn, each from its keyframe at or before
       * its `in` to its `out`, for a clock on the composition's time that starts at `from` and
       * runs on to `end`, all in microseconds. Each clip's video packets go into `ring`, followed
       * by a CUT record, and its audio into `pcm`, with silence wherever no clip's audio plays.
       * `buffered` is sent once `pcm` holds `preroll` frames, is full or has all the audio.
       */
      type: "track";
      id: number;
      ring: SharedArrayBuffer;
      pcm: SharedArrayBuffer;
      from: number;
      clips: Clip[];
      end: number;
      preroll: number;
    };

/** From the media worker to the main thread, each with the `id` of the request it answers. */
export type FromMedia =
  | ({ type: "opened"; id: number } & Opened)
  | { type: "buffered"; id: number }
  | { type: "demuxed"; id: number }
  | { type: "error"; id: number; message: string };

/**
 * From the render worker to the video decode worker (src/video.worker.ts), which runs the render
 * worker's FFmpeg decoders, each by its id (docs/architecture.md#video-output). `start` sends the
 * two rings (src/ring.ts) of TO_VIDEO and FROM_VIDEO records, once, so no message crosses per
 * packet or frame. `packets` sends a decoder's packet ring before it opens: its packets stay
 * there and the worker copies each out itself, so only where a packet is crosses.
 */
export type ToVideo =
  | { type: "start"; to: SharedArrayBuffer; from: SharedArrayBuffer }
  | { type: "packets"; id: number; ring: SharedArrayBuffer };
/** A module's memory, which its frames are read from, sent once it loads and before any frame. */
export type FromVideo = { type: "memory"; module: number; memory: WebAssembly.Memory };

/** The FFmpeg modules that decode video, by their index in records. */
export const VIDEO_MODULES = ["video", "video-ext"] as const;

/**
 * The kind of a record to the video decode worker, in the low KIND_BITS of its stream, with its
 * decoder's id in the rest. A decoder gets an `open`, its packets in decoding order, a `flush` at
 * the stream's end, and a `close`.
 * - `open`: the index in VIDEO_MODULES of the module that decodes the stream in the duration, its
 *   time base in pts (numerator) and dts (denominator), and its exported codec parameters as
 *   payload.
 * - `packet`: one record of the decoder's packet ring, with its packet's header, timestamps in the
 *   time base, and its place in that ring (PLACE) as payload.
 * - `release`: a frame going back once uploaded or dropped, whether its decoder is open or not:
 *   the frame in the flags, its module in the duration, and in the pts whether it is packed (1)
 *   or not (0).
 */
export const TO_VIDEO = { open: 0, packet: 1, flush: 2, close: 3, release: 4 } as const;
/**
 * The kind of a record from the video decode worker, laid out as TO_VIDEO's: `frame`, a decoded
 * frame with FRAME as payload; `decoded`, a packet decoded; `flushed`, the flush done; `failed`,
 * the decoder's first error as its message, after which it decodes nothing; and `taken`, a packet
 * ring record copied out, which the render worker then frees.
 */
export const FROM_VIDEO = { frame: 0, decoded: 1, flushed: 2, failed: 3, taken: 4 } as const;
export const KIND_BITS = 3;

/**
 * The payload of a `packet` record, by 32-bit word: where the payload of its packet ring record
 * starts and its size, and which PART of its packet it is (src/ring.ts); `bytes` is its length.
 */
export const PLACE = { start: 0, size: 1, part: 2, bytes: 12 } as const;

/**
 * The payload of a `frame` record, by 32-bit word except `timestamp`, a float64 indexed by 64-bit
 * word; `bytes` is its length. The frame stays in the shared memory of `module`, the module that
 * decoded it, until it is released: `frame` points to its AVFrame or, when `packed` is 1, to the
 * buffer a frame stored bottom row first was packed into. Then come its format, an index in
 * PIXEL_FORMATS; its sizes; `size`, the bytes it holds; and from `layout` on, the offset in that
 * memory and the stride of each of its `planes`.
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

/** The formats a frame may have, those `sny_to_video_format` makes, by their index in records. */
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

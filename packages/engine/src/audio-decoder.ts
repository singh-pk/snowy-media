// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The media worker's audio decoder: an audio stream decoded with the FFmpeg core and resampled
// into a PCM ring (src/pcm.ts) as the ring has room, from a queue of its compressed packets.

import {
  AV_NOPTS_VALUE,
  AVERROR_EAGAIN,
  AVERROR_EOF,
  type CoreModule,
  type Ptr,
} from "@snowy-media/ffmpeg/core";
import { createPcmProducer, pcmFormat } from "./pcm";
import type { ToMedia } from "./protocol";

type AudioRequest = NonNullable<Extract<ToMedia, { type: "demux" }>["audio"]>;

// How many bytes of compressed audio the media worker queues ahead of the PCM ring: minutes of
// AAC or Opus, tens of seconds of FLAC. It lets the demuxer run ahead of the audio clock, to the
// video packets and the end of the file long before they are due.
const AUDIO_AHEAD = 1 << 22;
// What a queued packet costs besides its payload: the AVPacket, its buffer and their padding,
// counted so that small or empty packets are bounded too.
const PACKET_OVERHEAD = 256;
// The frames of silence written at a time, from a buffer of zeros made once.
const SILENCE = 1024;

export interface Audio {
  stream: number;
  /**
   * Moves a packet of the stream out of `pkt` into the queue, or drops it once decoding is over,
   * as at a clip's end; false while the queue is full.
   */
  queue(pkt: Ptr): boolean;
  /** Decodes into the PCM ring as far as it has room; whether anything moved. */
  feed(): boolean;
  /** No more packets come: the decoder drains once the queue is empty. */
  end(): void;
  /** Whether it waits for room in the PCM ring. */
  waiting(): boolean;
  /** Whether all of it is in the PCM ring, or the ring's consumer has closed it. */
  done(): boolean;
  /** The PCM ring's doorbell, which the media worker sleeps on (src/pcm.ts). */
  bell(): number;
  sleep(seen: number): void;
  /** Raises or lowers the PCM ring's waiting flag. */
  wait(on: boolean): void;
  close(): void;
}

interface Ffmpeg {
  core: CoreModule;
  check: (ret: number, what: string) => void;
}

export interface AudioOptions {
  ffmpeg: Ffmpeg;
  /** The open file's demuxer. */
  ctx: number;
  request: AudioRequest;
  pcm: SharedArrayBuffer;
  /** Microseconds: the audio before it is dropped. */
  from: number;
  /**
   * Microseconds: where the clock starts, with silence up to where the audio starts, as after a
   * seek or in a gap before a clip; or undefined to start it at the first frame kept.
   */
  start: number | undefined;
  /** Microseconds: the audio from here on is dropped. */
  until: number;
  /** Runs once the ring holds the preroll, is full, or has all the audio. */
  buffered: () => void;
}

type Decoder = ReturnType<typeof openDecoder>;
type State = ReturnType<typeof createState>;

// Compressed packets in a circle of slots, which doubles when full, so it allocates only as it
// grows; it is bounded by AUDIO_AHEAD bytes.
function createPacketQueue(core: CoreModule) {
  const queued = { slots: [] as Ptr[], head: 0, count: 0, bytes: 0 };

  function grow() {
    const { slots, head } = queued;
    const more = Array.from({ length: Math.max(8, slots.length) }, () => core._sny_packet_alloc());

    if (more.includes(0)) {
      for (const slot of more) if (slot) core._sny_packet_free(slot);
      throw new Error("queue: out of memory");
    }

    // copy: only as the queue grows, its slots starting from the head.
    queued.slots = [...slots.slice(head), ...slots.slice(0, head), ...more];
    queued.head = 0;
  }

  // Moves `packet` into the queue; false while the queue is full.
  function put(packet: Ptr) {
    const size = core._sny_packet_size(packet) + PACKET_OVERHEAD;
    if (queued.count > 0 && queued.bytes + size > AUDIO_AHEAD) return false;
    if (queued.count === queued.slots.length) grow();
    const { slots, head, count } = queued;
    core._sny_packet_move(slots[(head + count) % slots.length] ?? 0, packet);
    queued.count++;
    queued.bytes += size;
    return true;
  }

  // Sends decoder `dec` the oldest packet, then keeps it in `spent` until the next, so its slot
  // is left empty; false if the queue is empty. A packet the decoder rejects is skipped, as the
  // ffmpeg command line does.
  function sendTo(dec: number, spent: Ptr) {
    const { slots, head, count } = queued;
    if (count === 0) return false;
    const slot = slots[head] ?? 0;
    queued.bytes -= core._sny_packet_size(slot) + PACKET_OVERHEAD;
    core._sny_decoder_send(dec, slot);
    core._sny_packet_move(spent, slot);
    queued.head = (head + 1) % slots.length;
    queued.count--;
    return true;
  }

  function free() {
    for (const slot of queued.slots) core._sny_packet_free(slot);
  }

  return { put, sendTo, free };
}

// The decoder of stream `stream`, and the frames, resampler and packet it works with. It throws
// if it cannot have them all, having freed those it had.
function openDecoder({ core, check }: Ffmpeg, ctx: number, stream: number) {
  const frame = core._sny_frame_alloc();
  const resampled = core._sny_frame_alloc();
  const resampler = core._sny_resampler_alloc();
  // The packet the decoder last took (createPacketQueue's sendTo).
  const spent = core._sny_packet_alloc();
  const out = core._malloc(4);
  const allocated = frame && resampled && resampler && spent && out;
  const opened = allocated ? core._sny_decoder_open(ctx, stream, out) : 0;
  const dec = allocated && opened >= 0 ? (core.HEAP32[out >>> 2] ?? 0) : 0;
  core._free(out);
  const decoder = { frame, resampled, resampler, spent, dec };

  if (!allocated || opened < 0) {
    freeDecoder(core, decoder);
    if (!allocated) throw new Error("decoder: out of memory");
    check(opened, "decoder_open");
  }

  return decoder;
}

function freeDecoder(core: CoreModule, decoder: Decoder) {
  core._sny_packet_free(decoder.spent);
  core._sny_resampler_free(decoder.resampler);
  core._sny_frame_free(decoder.resampled);
  core._sny_frame_free(decoder.frame);
  if (decoder.dec) core._sny_decoder_close(decoder.dec);
}

function createState(options: AudioOptions) {
  const { ffmpeg, ctx, request, pcm, from, start, until, buffered } = options;
  const { core } = ffmpeg;
  const { stream, preroll } = request;
  const { channels, rate } = pcmFormat(pcm);
  const producer = createPcmProducer(pcm);
  const st = core._sny_stream(ctx, stream);
  const timeBase = { num: core._sny_stream_tb_num(st), den: core._sny_stream_tb_den(st) };
  const decoder = openDecoder(ffmpeg, ctx, stream);
  return {
    ffmpeg,
    from,
    start,
    until,
    buffered,
    preroll,
    channels,
    rate,
    producer,
    timeBase,
    decoder,
    queue: createPacketQueue(core),
    // Frames written, silence included; and how many may be, up to `until`, once started.
    told: { buffered: false, written: 0, most: Infinity },
    // The resampled frames not yet in the ring: `left` frames from index `at` of HEAPF32; how
    // many more to drop, as they come before `from`; and the frames of silence before them.
    pending: { at: 0, left: 0, skip: 0, silence: 0 },
    zeros: new Float32Array(SILENCE * channels),
    phase: {
      started: false,
      // No more packets come; the decoder has been sent the end; the resampler is drained.
      ended: false,
      sentEnd: false,
      flushed: false,
      done: false,
      closed: false,
    },
  };
}

function tell(a: State) {
  if (!a.told.buffered) a.buffered();
  a.told.buffered = true;
}

// Sends the decoder the next queued packet, or the end; false if there is neither yet.
function send(a: State) {
  const { dec, spent } = a.decoder;
  if (a.queue.sendTo(dec, spent)) return true;
  if (!a.phase.ended || a.phase.sentEnd) return false;
  a.ffmpeg.core._sny_decoder_send(dec, 0);
  a.phase.sentEnd = true;
  return true;
}

// Resamples `input` (0 at the end) into the pending frames.
function resample(a: State, input: Ptr) {
  const { core, check } = a.ffmpeg;
  const { pending, channels } = a;
  const { resampler, resampled } = a.decoder;
  check(core._sny_resample(resampler, input, resampled, a.rate, channels), "resample");
  pending.at = core._sny_frame_plane(resampled, 0) >>> 2;
  pending.left = core._sny_frame_samples(resampled);
  const skipped = Math.min(pending.skip, pending.left);
  pending.at += skipped * channels;
  pending.left -= skipped;
  pending.skip -= skipped;
}

// Writes pending frames into the ring; false once it is full. A full ring holds a second and
// more, more than any preroll.
function write(a: State) {
  const { pending, producer } = a;

  // At `until`: what is left is dropped, and no more is decoded.
  if (a.told.written >= a.told.most) {
    pending.silence = 0;
    pending.left = 0;
    a.phase.flushed = true;
    return true;
  }

  const silent = pending.silence > 0;
  // HEAPF32 is read for each write: the heap's buffer changes when memory grows.
  const room = a.told.most - a.told.written;
  const n = silent
    ? producer.offer(a.zeros, 0, Math.min(pending.silence, SILENCE, room))
    : producer.offer(a.ffmpeg.core.HEAPF32, pending.at, Math.min(pending.left, room));

  if (n < 0) {
    a.phase.closed = true;
    return true;
  }

  if (n === 0) {
    tell(a);
    return false;
  }

  if (silent) {
    pending.silence -= n;
  } else {
    pending.at += n * a.channels;
    pending.left -= n;
  }

  a.told.written += n;
  if (a.told.written >= a.preroll) tell(a);
  return true;
}

// Starts the clock at the first decoded frame: the audio before `from` is dropped; given a
// start, silence fills from it to where the audio starts, so the clock starts there: after a
// seek, where Opus, for one, drops its first frames, and in a gap before a clip.
function startClock(a: State) {
  const { from, rate, pending, timeBase } = a;
  const pts = a.ffmpeg.core._sny_frame_pts(a.decoder.frame);
  const first = pts === AV_NOPTS_VALUE ? 0 : (Number(pts) * timeBase.num) / timeBase.den;
  const late = (first - from / 1e6) * rate;
  // Rounded down: the clock starts no later than `from`, so it shows no frame due after.
  pending.skip = Math.max(0, Math.floor(-late));
  const kept = first + pending.skip / rate;
  const clock = a.start === undefined ? kept : Math.min(kept, a.start / 1e6);
  pending.silence = Math.max(0, Math.round((kept - clock) * rate));
  a.told.most = Math.max(0, Math.round((a.until / 1e6 - clock) * rate));
  a.producer.start(clock);
  a.phase.started = true;
}

function feed(a: State) {
  const { core, check } = a.ffmpeg;
  const { phase, pending, decoder } = a;
  let moved = false;

  while (!phase.closed && !phase.done) {
    if (pending.silence > 0 || pending.left > 0) {
      if (!write(a)) return moved;
      moved = true;
      continue;
    }

    if (phase.flushed) {
      phase.done = true;
      a.producer.finish();
      tell(a);
      return true;
    }

    const ret = core._sny_decoder_receive(decoder.dec, decoder.frame);

    if (ret === AVERROR_EOF) {
      resample(a, 0);
      phase.flushed = true;
    } else if (ret === AVERROR_EAGAIN) {
      if (!send(a)) return moved;
      moved = true;
    } else {
      check(ret, "decoder_receive");
      if (!phase.started) startClock(a);
      resample(a, decoder.frame);
    }
  }

  // Done or closed counted once, on the pass that got there.
  return moved;
}

/**
 * Decodes the requested audio stream into its PCM ring, from the packets `queue` takes, as the
 * ring has room. Once the ring's consumer closes it, the queue takes packets and drops them.
 * `close` frees it all.
 */
export function createAudio(options: AudioOptions): Audio {
  const a = createState(options);
  const { core } = a.ffmpeg;
  const { phase, pending, producer } = a;

  function close() {
    a.queue.free();
    freeDecoder(core, a.decoder);
  }

  return {
    stream: options.request.stream,
    queue: (pkt) => phase.closed || phase.done || a.queue.put(pkt),
    feed: () => feed(a),
    end: () => {
      phase.ended = true;
    },
    waiting: () => (pending.silence > 0 || pending.left > 0) && !phase.closed,
    done: () => phase.done || phase.closed,
    bell: producer.bell,
    sleep: producer.sleep,
    wait: producer.waitingForRoom,
    close,
  };
}

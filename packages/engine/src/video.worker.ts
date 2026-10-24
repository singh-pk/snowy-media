// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The video decode worker: decodes, with FFmpeg's `video` or `video-ext` module, the video
// streams WebCodecs does not, for the render worker (src/wasm-video.ts). FFmpeg decodes
// synchronously, in software, so it does so here, never in the render worker's animation
// frames. Each frame, in a format VideoFrame takes (sny_to_video_format), stays where the
// decoder left it in the module's shared memory, which the render worker uploads it from; the
// render worker sends it back once it is uploaded or dropped. Packets and frames go both ways
// through the rings the render worker sends at the start, with no message per packet or frame.

import {
  AVERROR_EAGAIN,
  AVERROR_EOF,
  createVideo,
  type VideoModule,
} from "@snowy-media/ffmpeg/video";
import {
  FRAME,
  FROM_VIDEO,
  KIND_BITS,
  PIXEL_FORMATS,
  TO_VIDEO,
  VIDEO_MODULES,
  type FromVideo,
  type ToVideo,
} from "./protocol";
import { createConsumer, createProducer, type Packet } from "./ring";

type Ptr = number;
type Module = (typeof VIDEO_MODULES)[number];

const LOG_ERRORS = 16;
// The most planes a frame has: Y, Cb, Cr and alpha.
const MAX_PLANES = 4;
// Decoding threads: one a core, at most the module's pool of 8.
const THREADS = Math.min(navigator.hardwareConcurrency, 8);

// Where a frame record's payload is put together.
const payload = new Uint8Array(FRAME.bytes);
const words = new Int32Array(payload.buffer);
const doubles = new Float64Array(payload.buffer);
// Where a failure's message is put; a longer one is cut short.
const message = new Uint8Array(1024);

// Module `name`, loaded when a stream first needs it: video-ext only for the rarer codecs.
async function load(name: Module): Promise<VideoModule> {
  if (name === "video") {
    const m = await createVideo();
    m._sny_set_log_level(LOG_ERRORS);
    return m;
  }

  const { createVideoExt } = await import("@snowy-media/ffmpeg/video-ext");
  const m = await createVideoExt();
  m._sny_set_log_level(LOG_ERRORS);
  return m;
}

// A decoder of stream parameters `params` in module `m`, the `module`th, with time base
// `num`/`den`, sending each frame it decodes with `send`.
function createDecoder(
  m: VideoModule,
  module: number,
  params: Uint8Array,
  num: number,
  den: number,
  send: () => void,
) {
  const check = (ret: number, what: string) => {
    if (ret < 0) throw new Error(`${what}: ${m.UTF8ToString(m._sny_strerror(ret))}`);
    return ret;
  };

  const name = (ptr: Ptr) => (ptr ? m.UTF8ToString(ptr) : "");
  // Rounded as src/video.ts rounds the packets' timestamps, so a frame's matches its packet's.
  const micros = (t: bigint) => Math.round((Number(t) * num * 1e6) / den);

  // A view of all of memory. The module's HEAPU8 is not: the decoder's threads grow memory
  // as they allocate frames, and HEAPU8 follows only growth on this thread.
  const memory = { view: new Uint8Array(m.wasmMemory.buffer) };

  const heap = () => {
    const { buffer } = m.wasmMemory;
    if (memory.view.buffer !== buffer) memory.view = new Uint8Array(buffer);
    return memory.view;
  };

  const buf = m._malloc(params.length);
  heap().set(params, buf);
  const out = m._malloc(4);
  const opened = m._sny_decoder_open_params(buf, params.length, THREADS, out);
  const dec = new DataView(m.wasmMemory.buffer).getInt32(out, true);
  m._free(out);
  m._free(buf);
  check(opened, "decoder_open_params");
  const pkt = m._sny_packet_alloc();
  const frame = m._sny_frame_alloc();
  const sws = m._sny_scaler_alloc();

  function close() {
    m._sny_decoder_close(dec);
    m._sny_packet_free(pkt);
    m._sny_frame_free(frame);
    m._sny_scaler_free(sws);
  }

  if (!pkt || !frame || !sws) {
    close();
    throw new Error("decoder: out of memory");
  }

  // The index of `held`'s format in PIXEL_FORMATS.
  function pixelFormat(held: Ptr) {
    const format = name(m._sny_frame_video_format(held));
    const index = PIXEL_FORMATS.findIndex((f) => f === format);
    if (index < 0) throw new Error(`no VideoFrame format for ${format}`);
    return index;
  }

  // Puts where each plane of `held` starts in memory, and its stride, in the payload, and
  // returns how many it has; 0 if one is stored bottom row first (a negative stride), as a
  // texture is never uploaded. A format's unused planes have no data.
  function planes(held: Ptr) {
    let i = 0;

    for (; i < MAX_PLANES && m._sny_frame_data(held, i); i++) {
      const stride = m._sny_frame_linesize(held, i);
      if (stride <= 0) return 0;
      words[FRAME.layout + 2 * i] = m._sny_frame_data(held, i);
      words[FRAME.layout + 2 * i + 1] = stride;
    }

    return i;
  }

  // `held`, stored bottom row first, as a raw AVI's or a BMP's RGB is, packed top row first into
  // a buffer of its own, of `size` bytes, which stands for it from then on. Such a frame is RGB:
  // one plane, 4 bytes a pixel, `width` pixels a row. Returns the buffer.
  function pack(held: Ptr, size: number, width: number) {
    if (m._sny_frame_data(held, 1)) throw new Error("a planar frame stored bottom row first");
    const at = m._malloc(size);
    if (!at) throw new Error("malloc: out of memory");
    const packed = m._sny_frame_pack(held, at, size);

    if (packed < 0) {
      m._free(at);
      check(packed, "frame_pack");
    }

    m._sny_frame_free(held);
    words[FRAME.layout] = at;
    words[FRAME.layout + 1] = width * 4;
    return at;
  }

  // The decoded frame, held in a reference of its own (or converted into a frame of its own) so
  // the decoder does not reuse its buffers before it goes back, put in the payload.
  function hold() {
    const held = m._sny_frame_alloc();
    if (!held) throw new Error("frame_alloc: out of memory");

    try {
      check(m._sny_to_video_format(sws, frame, held), "to_video_format");
      const width = m._sny_frame_width(held);
      const height = m._sny_frame_height(held);
      const [sarNum, sarDen] = [m._sny_frame_sar_num(frame), m._sny_frame_sar_den(frame)];
      // Non-square pixels widen or narrow it, as a WebCodecs decoder's display aspect does.
      const displayWidth = sarNum > 0 && sarDen > 0 ? Math.round((width * sarNum) / sarDen) : width;
      words[FRAME.format] = pixelFormat(held);
      words[FRAME.module] = module;
      words[FRAME.codedWidth] = width;
      words[FRAME.codedHeight] = height;
      words[FRAME.displayWidth] = displayWidth;
      const size = check(m._sny_frame_pack_size(held), "frame_pack_size");
      words[FRAME.size] = size;
      doubles[FRAME.timestamp] = micros(m._sny_frame_pts(frame));
      const count = planes(held);
      words[FRAME.planes] = count || 1;
      words[FRAME.packed] = count ? 0 : 1;
      // Last, as packing frees `held`.
      words[FRAME.frame] = count ? held : pack(held, size, width);
    } catch (e) {
      m._sny_frame_free(held);
      throw e;
    }
  }

  // Sends `packet` (0 to drain) and sends on every frame it completes. A packet the decoder
  // rejects, or a frame it fails to decode, is skipped, as the ffmpeg command line does: with
  // frame threads, a broken packet's error comes out of receive.
  function decode(packet: Ptr) {
    for (;;) {
      const sent = m._sny_decoder_send(dec, packet);

      for (;;) {
        const got = m._sny_decoder_receive(dec, frame);
        if (got === AVERROR_EAGAIN || got === AVERROR_EOF) break;
        if (got < 0) continue;
        hold();
        send();
      }

      // Full, it takes the packet once its frames are out.
      if (sent !== AVERROR_EAGAIN) return;
    }
  }

  return {
    // Copies `packet` into memory, to decode once its record is freed.
    put({ data, pts, dts, duration, flags }: Packet) {
      const at = m._sny_packet_make(pkt, data.length, pts, dts, BigInt(duration), flags);
      if (!at) throw new Error("packet_make: out of memory");
      heap().set(data, at);
    },
    decode: () => decode(pkt),
    flush: () => decode(0),
    close,
  };
}

type Decoder = ReturnType<typeof createDecoder>;

// Serves the render worker through the rings of `start`.
async function serve({ to, from }: ToVideo) {
  const records = createConsumer(to);
  const replies = createProducer(from);
  // The modules loaded, for a frame that goes back.
  const loaded: (VideoModule | undefined)[] = [];
  // Open decoders by id; one that failed stays, without a decoder, until it closes.
  const decoders = new Map<number, Decoder | undefined>();
  const encoder = new TextEncoder();

  const reply = (id: number, kind: number, data = payload, size = 0) =>
    replies.write((id << KIND_BITS) | kind, 0, 0n, 0n, 0, data, 0, size);

  // The `index`th module, loaded once; its memory goes to the render worker before any frame.
  async function module(index: number) {
    const name = VIDEO_MODULES[index];
    if (!name) throw new Error(`no video module ${index}`);

    const had = loaded[index];
    if (had) return had;
    const m = await load(name);
    loaded[index] = m;
    const memory: FromVideo = { type: "memory", module: index, memory: m.wasmMemory };
    self.postMessage(memory);
    return m;
  }

  // Handles `record` of decoder `id`; it is freed once this returns, or before decoding.
  async function handle(record: Packet, id: number, kind: number) {
    if (kind === TO_VIDEO.release) {
      const m = loaded[record.duration];
      // A pointer, unsigned past 2 GiB.
      const frame = record.flags >>> 0;
      if (record.pts) m?._free(frame);
      else m?._sny_frame_free(frame);
      return;
    }

    if (kind === TO_VIDEO.open) {
      const m = await module(record.duration);
      const send = () => reply(id, FROM_VIDEO.frame, payload, FRAME.bytes);
      const [num, den] = [Number(record.pts), Number(record.dts)];
      decoders.set(id, createDecoder(m, record.duration, record.data, num, den, send));
      return;
    }

    const decoder = decoders.get(id);

    if (kind === TO_VIDEO.close) {
      decoder?.close();
      decoders.delete(id);
    } else if (kind === TO_VIDEO.packet) {
      // Freed before decoding, which takes long, so the render worker has room for the next.
      try {
        decoder?.put(record);
      } finally {
        records.release();
      }

      decoder?.decode();
      reply(id, FROM_VIDEO.decoded);
    } else {
      decoder?.flush();
      reply(id, FROM_VIDEO.flushed);
    }
  }

  // Records are handled one at a time, in order: an open waits for its module, and the records
  // behind it wait for the decoder.
  for (;;) {
    const record = records.peek();

    if (!record) {
      await records.wait();
      continue;
    }

    const id = record.stream >> KIND_BITS;
    const kind = record.stream & ((1 << KIND_BITS) - 1);

    try {
      await handle(record, id, kind);
    } catch (e) {
      // It decodes nothing more, but stays until it closes.
      decoders.get(id)?.close();
      decoders.set(id, undefined);
      const { written } = encoder.encodeInto(e instanceof Error ? e.message : String(e), message);
      reply(id, FROM_VIDEO.failed, message, written);
    }

    // A packet's record is freed already.
    if (kind !== TO_VIDEO.packet) records.release();
  }
}

addEventListener("message", ({ data }: MessageEvent<ToVideo>) => void serve(data), {
  once: true,
});

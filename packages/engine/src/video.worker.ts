// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The video decode worker, for the streams WebCodecs does not decode. FFmpeg decodes
// synchronously, so it does so here, never in the render worker's animation frames. A frame stays
// in the module's shared memory, which the render worker uploads it from, until it is sent back.

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
  PLACE,
  TO_VIDEO,
  VIDEO_MODULES,
  type FromVideo,
  type ToVideo,
} from "./protocol";
import {
  PART,
  createConsumer,
  createPlaceReader,
  createProducer,
  type Packet,
  type Place,
} from "./ring";

type Ptr = number;
type Module = (typeof VIDEO_MODULES)[number];

const LOG_ERRORS = 16;
// The most planes a frame has: Y, Cb, Cr and alpha.
const MAX_PLANES = 4;
// Decoding threads: one a core, at most the module's pool of 8.
const THREADS = Math.min(navigator.hardwareConcurrency, 8);

const payload = new Uint8Array(FRAME.bytes);
const words = new Int32Array(payload.buffer);
const doubles = new Float64Array(payload.buffer);
// Where a failure's message is put; a longer one is cut short.
const message = new Uint8Array(1024);
const placeWords = new Int32Array(PLACE.bytes / 4);
const placeBytes = new Uint8Array(placeWords.buffer);
const completes = (part: number | undefined) => part === PART.whole || part === PART.last;

// Where the packet ring record is that the last packet record read places, filled by `placeOf`.
const placed: Place = { start: 0, size: 0, part: PART.whole };

function placeOf(record: Packet) {
  // copy: 12 bytes, into words to read them.
  placeBytes.set(record.data);
  placed.start = placeWords[PLACE.start] ?? 0;
  placed.size = placeWords[PLACE.size] ?? 0;
  placed.part = placeWords[PLACE.part] ?? 0;
  return placed;
}

// Each decoder's packet ring, by its id, as it comes by message.
const packetRings = new Map<number, PromiseWithResolvers<SharedArrayBuffer>>();

// Decoder `id`'s packet ring, whichever comes first, its message or its open.
function packetRing(id: number) {
  const known = packetRings.get(id);
  if (known) return known;
  const ring = Promise.withResolvers<SharedArrayBuffer>();
  packetRings.set(id, ring);
  return ring;
}

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

// `ret`, unless it is an FFmpeg error, which throws with what `what` was.
function check(m: VideoModule, ret: number, what: string) {
  if (ret < 0) throw new Error(`${what}: ${m.UTF8ToString(m._sny_strerror(ret))}`);
  return ret;
}

// A decoder opened from stream parameters `params`. `heap` gives a view of all of memory, taken
// after the allocation because that can grow memory.
function openDecoder(m: VideoModule, params: Uint8Array, heap: () => Uint8Array) {
  const buf = m._malloc(params.length);
  heap().set(params, buf);
  const out = m._malloc(4);
  const opened = m._sny_decoder_open_params(buf, params.length, THREADS, out);
  const dec = new DataView(m.wasmMemory.buffer).getInt32(out, true);
  m._free(out);
  m._free(buf);
  check(m, opened, "decoder_open_params");
  return dec;
}

// The index of `held`'s format in PIXEL_FORMATS, remembered in `formats` by its name's pointer:
// a static string.
function pixelFormat(m: VideoModule, formats: Map<Ptr, number>, held: Ptr) {
  const ptr = m._sny_frame_video_format(held);
  const known = formats.get(ptr);
  if (known !== undefined) return known;
  const format = ptr ? m.UTF8ToString(ptr) : "";
  const index = PIXEL_FORMATS.findIndex((f) => f === format);
  if (index < 0) throw new Error(`no VideoFrame format for ${format}`);
  formats.set(ptr, index);
  return index;
}

// Puts where each plane of `held` starts in memory, and its stride, in the payload, and
// returns how many it has; 0 if one is stored bottom row first (a negative stride), as a
// texture is never uploaded. A format's unused planes have no data.
function planes(m: VideoModule, held: Ptr) {
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
function pack(m: VideoModule, held: Ptr, size: number, width: number) {
  if (m._sny_frame_data(held, 1)) throw new Error("a planar frame stored bottom row first");
  const at = m._malloc(size);
  if (!at) throw new Error("malloc: out of memory");
  const packed = m._sny_frame_pack(held, at, size);

  if (packed < 0) {
    m._free(at);
    check(m, packed, "frame_pack");
  }

  m._sny_frame_free(held);
  words[FRAME.layout] = at;
  words[FRAME.layout + 1] = width * 4;
  return at;
}

// What copies packet ring records of `packets` into packet `pkt` of module `m`, whose memory
// `heap` views, putting a packet's pieces back together first.
function createTaker(m: VideoModule, pkt: Ptr, heap: () => Uint8Array, packets: SharedArrayBuffer) {
  // copy: a piece, out of a ring record freed before the next comes, and the packet's size
  // known only at its last piece.
  const { pieces, read, join } = createPlaceReader(packets);

  // Where in memory a packet of `size` bytes, with the header of `record`, goes.
  function make({ pts, dts, duration, flags }: Packet, size: number) {
    const at = m._sny_packet_make(pkt, size, pts, dts, BigInt(duration), flags);
    if (!at) throw new Error("packet_make: out of memory");
    return at;
  }

  return {
    /**
     * Copies the packet ring record at `place`, with its packet's header `record`, into memory,
     * where the packet is decoded from once whole: a piece waits for the rest. Whether it is.
     */
    take(record: Packet, place: Place) {
      if (place.part === PART.whole) {
        const at = make(record, place.size);
        // copy: into the module's memory, which FFmpeg decodes from; the ring record is freed
        // after.
        read(place, heap(), at);
        return true;
      }

      join(place);
      if (place.part === PART.piece) return false;
      const at = make(record, pieces.length);
      // copy: the pieces, into the packet in memory.
      heap().set(pieces.data.subarray(0, pieces.length), at);
      pieces.length = 0;
      return true;
    },
  };
}

// `num`/`den` is the stream's time base; `send` sends each frame decoded.
interface DecoderOptions {
  module: number;
  params: Uint8Array;
  num: number;
  den: number;
  packets: SharedArrayBuffer;
  send: () => void;
}

function createDecoder(m: VideoModule, options: DecoderOptions) {
  const { module, params, num, den, packets, send } = options;
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

  const dec = openDecoder(m, params, heap);
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

  const formats = new Map<Ptr, number>();

  // The decoded frame, held in a reference of its own (or converted into a frame of its own) so
  // the decoder does not reuse its buffers before it goes back, put in the payload.
  function hold() {
    const held = m._sny_frame_alloc();
    if (!held) throw new Error("frame_alloc: out of memory");

    try {
      check(m, m._sny_to_video_format(sws, frame, held), "to_video_format");
      const width = m._sny_frame_width(held);
      const height = m._sny_frame_height(held);
      const [sarNum, sarDen] = [m._sny_frame_sar_num(frame), m._sny_frame_sar_den(frame)];
      // Non-square pixels widen or narrow it, as a WebCodecs decoder's display aspect does.
      const displayWidth = sarNum > 0 && sarDen > 0 ? Math.round((width * sarNum) / sarDen) : width;
      words[FRAME.format] = pixelFormat(m, formats, held);
      words[FRAME.module] = module;
      words[FRAME.codedWidth] = width;
      words[FRAME.codedHeight] = height;
      words[FRAME.displayWidth] = displayWidth;
      const size = check(m, m._sny_frame_pack_size(held), "frame_pack_size");
      words[FRAME.size] = size;
      doubles[FRAME.timestamp] = micros(m._sny_frame_pts(frame));
      const count = planes(m, held);
      words[FRAME.planes] = count || 1;
      words[FRAME.packed] = count ? 0 : 1;
      // Last, as packing frees `held`.
      words[FRAME.frame] = count ? held : pack(m, held, size, width);
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

  const taker = createTaker(m, pkt, heap, packets);

  return {
    take: (record: Packet, place: Place) => taker.take(record, place),
    decode: () => decode(pkt),
    flush: () => decode(0),
    close,
  };
}

type Decoder = ReturnType<typeof createDecoder>;

// The modules, each loaded once, when a decoder first needs it, and kept for the frames that go
// back to it.
function createModules() {
  const loaded: (VideoModule | undefined)[] = [];

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

  return { loaded, module };
}

async function serve({ to, from }: Extract<ToVideo, { type: "start" }>) {
  const records = createConsumer(to);
  const replies = createProducer(from);
  const { loaded, module } = createModules();
  // Open decoders by id; one that failed stays, without a decoder, until it closes.
  const decoders = new Map<number, Decoder | undefined>();
  const encoder = new TextEncoder();

  const reply = (id: number, kind: number, data = payload, size = 0) => {
    const { packet } = replies;
    packet.stream = (id << KIND_BITS) | kind;
    packet.data = data;
    packet.size = size;
    return replies.write(packet);
  };

  // Opens decoder `id` from its `open` record, once its module is loaded and its packet ring
  // has come.
  async function open(record: Packet, id: number) {
    const m = await module(record.duration);
    const packets = await packetRing(id).promise;
    const send = () => reply(id, FROM_VIDEO.frame, payload, FRAME.bytes);
    const [num, den] = [Number(record.pts), Number(record.dts)];
    const options = { module: record.duration, params: record.data, num, den, packets, send };
    decoders.set(id, createDecoder(m, options));
  }

  // Takes the packet ring record that packet record `record` of decoder `id` places, then frees
  // `record` and says the other is taken, so the render worker frees it, before any decoding.
  // Whether its packet is whole, failed decoder or not.
  function take(record: Packet, id: number) {
    const place = placeOf(record);

    try {
      decoders.get(id)?.take(record, place);
    } finally {
      records.release();
      reply(id, FROM_VIDEO.taken);
    }

    return completes(place.part);
  }

  // Handles any other `record` of decoder `id`; it is freed once this returns, or a packet's
  // before decoding.
  function handle(record: Packet, id: number, kind: number) {
    const decoder = decoders.get(id);

    if (kind === TO_VIDEO.close) {
      decoder?.close();
      decoders.delete(id);
      packetRings.delete(id);
    } else if (kind === TO_VIDEO.packet) {
      // Taken before decoding, which takes long, so the render worker hands on the next.
      if (!take(record, id)) return;
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

    // A frame going back is of no decoder: id 0 is only its kind's.
    if (kind === TO_VIDEO.release) {
      const m = loaded[record.duration];
      // A pointer, unsigned past 2 GiB.
      const frame = record.flags >>> 0;
      if (record.pts) m?._free(frame);
      else m?._sny_frame_free(frame);
      records.release();
      continue;
    }

    try {
      if (kind === TO_VIDEO.open) await open(record, id);
      else handle(record, id, kind);
    } catch (e) {
      // It decodes nothing more, but stays until it closes.
      decoders.get(id)?.close();
      decoders.set(id, undefined);
      const { written } = encoder.encodeInto(e instanceof Error ? e.message : String(e), message);
      reply(id, FROM_VIDEO.failed, message, written);

      // A whole packet still decoded, as the render worker counts it handed over.
      if (kind === TO_VIDEO.packet && completes(placed.part)) {
        reply(id, FROM_VIDEO.decoded);
      }
    }

    // A packet's record is freed already.
    if (kind !== TO_VIDEO.packet) records.release();
  }
}

addEventListener("message", ({ data }: MessageEvent<ToVideo>) => {
  if (data.type === "start") void serve(data);
  else packetRing(data.id).resolve(data.ring);
});

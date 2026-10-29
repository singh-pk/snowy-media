// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Stand-ins for `VideoDecoder` for the video streams WebCodecs does not decode, which hand their
// packets to the decode worker, src/video.worker.ts (docs/architecture.md#video-output). That
// worker is started once and kept, so a seek or another file does not load its module again.

import type { VideoParams } from "./codec";
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
  createProducer,
  createRing,
  type OutgoingPacket,
  type Packet,
  type Place,
} from "./ring";

// The ring to the worker carries small records only: a packet's place, never its bytes. It holds
// one packet's place at a time, as the decode loop waits for each to be taken, and the 32-byte
// records of the frames shown meanwhile going back. The ring back carries small records too.
const TO_CAPACITY = 1 << 20;
// A frame's `packed` word (0 or 1), as the release record's `pts`.
const PACKED = [0n, 1n] as const;
const FROM_CAPACITY = 1 << 16;

const FORMATS: ReadonlySet<string | undefined> = new Set(PIXEL_FORMATS);
// TypeScript's DOM types know fewer pixel formats than Chromium takes.
const isFormat = (v: string | undefined): v is VideoPixelFormat => FORMATS.has(v);

/**
 * A frame FFmpeg decoded, whose planes stay in the decoding module's `memory` at the offsets in
 * `layout`. It is uploaded to the GPU from there, so it is never copied on the CPU. Closing it
 * hands it back to the module to free.
 */
interface SharedFrame {
  readonly format: VideoPixelFormat;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly timestamp: number;
  readonly layout: PlaneLayout[];
  readonly memory: WebAssembly.Memory;
  allocationSize(): number;
  close(): void;
}

export type DecodedFrame = VideoFrame | SharedFrame;

/** Where a decoder's frames, its taking a packet, and its failure go. */
export interface DecoderEvents {
  output: (frame: DecodedFrame) => void;
  dequeue: () => void;
  error: (e: Error) => void;
}

/** A video decoder, as src/video.ts uses one. */
export interface Decoder {
  /**
   * Set only on a decoder that copies its packets out of the packet ring itself: src/video.ts
   * writes the place of the record it hands on next into it (with `peekPlace`), and hands the
   * record on unread. Undefined on a decoder that takes a packet's bytes.
   */
  readonly place?: Place;
  /**
   * Decodes `packet`, whose frame is due at `pts` in the stream's time base (the packet's pts, or
   * its dts where it has none), and at `timestamp` for `duration`, in microseconds. Returns
   * whether the decoder now has all of a packet: a packet in pieces comes one record at a time,
   * at `place`, and only its last piece completes it.
   */
  decode(packet: Packet, pts: bigint, timestamp: number, duration: number): boolean;
  /** Resolves once every packet is decoded and its frames are out. */
  flush(): Promise<void>;
  /** Packets handed over and not yet decoded. */
  queued(): number;
  /** Whether it is still reading the record last handed to it, which is not freed until then. */
  reading(): boolean;
  close(): void;
}

interface Open {
  events: DecoderEvents;
  queued: number;
  // Made only by a flush, so a close rejects a promise only when a flush awaits it.
  flushed?: PromiseWithResolvers<void>;
  // A packet ring record handed over and not yet copied out.
  reading: boolean;
}

type Producer = ReturnType<typeof createProducer>;

// Hands frame `frame` back to the `module`th module, which decoded it; `packed` if the worker
// packed it into a buffer of its own.
type GiveBack = (frame: number, packed: bigint, module: number) => void;

interface Wasm {
  state: { next: number; failed: Error | undefined };
  open: Map<number, Open>;
  /** Posts `message` to the worker, started first if it is not. */
  post: (message: ToVideo) => void;
  /** A record of `stream`, its other fields cleared, to fill and `put`. */
  record: (stream: number) => OutgoingPacket;
  /** Writes a record that must go; throws if the ring has no room for it. */
  put: (packet: OutgoingPacket) => void;
}

// The frame in the payload that `words` and `doubles` view, from the module whose memory is
// `memory`, as a frame that goes back to it with `giveBack` once closed. Pointers are read
// unsigned, as they may lie past 2 GiB.
function sharedFrame(
  words: Int32Array,
  doubles: Float64Array,
  memory: WebAssembly.Memory,
  giveBack: GiveBack,
): SharedFrame {
  const frame = (words[FRAME.frame] ?? 0) >>> 0;
  const packed = PACKED[words[FRAME.packed] ?? 0] ?? 0n;
  const module = words[FRAME.module] ?? 0;
  const size = words[FRAME.size] ?? 0;
  const height = words[FRAME.codedHeight] ?? 0;
  const layout: PlaneLayout[] = [];

  for (let i = 0; i < (words[FRAME.planes] ?? 0); i++) {
    const offset = (words[FRAME.layout + 2 * i] ?? 0) >>> 0;
    layout.push({ offset, stride: words[FRAME.layout + 2 * i + 1] ?? 0 });
  }

  const format = PIXEL_FORMATS[words[FRAME.format] ?? 0];

  if (!isFormat(format)) {
    giveBack(frame, packed, module);
    throw new Error(`no pixel format ${words[FRAME.format]}`);
  }

  const own = { closed: false };
  return {
    format,
    codedWidth: words[FRAME.codedWidth] ?? 0,
    codedHeight: height,
    displayWidth: words[FRAME.displayWidth] ?? 0,
    displayHeight: height,
    timestamp: doubles[FRAME.timestamp] ?? 0,
    layout,
    memory,
    allocationSize: () => size,
    close() {
      if (own.closed) return;
      // Marked closed only once given back: if the ring has no room, `giveBack` throws and the
      // frame stays open.
      giveBack(frame, packed, module);
      own.closed = true;
    },
  };
}

function createReplies(open: Map<number, Open>, giveBack: GiveBack) {
  // Each module's memory, which its frames are read from, once the worker has loaded it.
  const memories = VIDEO_MODULES.map(() => Promise.withResolvers<WebAssembly.Memory>());
  const loaded: (WebAssembly.Memory | undefined)[] = [];
  // Where a frame record's payload is read from.
  const payload = new Uint8Array(FRAME.bytes);
  const words = new Int32Array(payload.buffer);
  const doubles = new Float64Array(payload.buffer);
  const text = new TextDecoder();
  // Where a failure's message is copied to be decoded: TextDecoder takes no shared memory.
  const reason = new Uint8Array(1024);

  function release() {
    const frame = (words[FRAME.frame] ?? 0) >>> 0;
    giveBack(frame, PACKED[words[FRAME.packed] ?? 0] ?? 0n, words[FRAME.module] ?? 0);
  }

  // Hands record `record` of decoder `id` from the worker to it; a frame's payload is in
  // `payload` already.
  function receive(record: Packet, id: number, kind: number) {
    const decoder = open.get(id);

    if (kind === FROM_VIDEO.frame) {
      const memory = loaded[words[FRAME.module] ?? 0];
      // A decoder closed since: nothing takes it, so it goes back at once.
      if (memory && decoder) decoder.events.output(sharedFrame(words, doubles, memory, giveBack));
      else release();
    } else if (kind === FROM_VIDEO.decoded) {
      if (decoder) decoder.queued--;
      decoder?.events.dequeue();
    } else if (kind === FROM_VIDEO.taken) {
      if (decoder) decoder.reading = false;
      decoder?.events.dequeue();
    } else if (kind === FROM_VIDEO.failed) {
      reason.set(record.data);
      decoder?.events.error(new Error(text.decode(reason.subarray(0, record.data.length))));
    } else {
      decoder?.flushed?.resolve();
    }
  }

  // Takes the worker's records from `replies` as they come, in order. One its decoder fails on
  // fails that decoder alone.
  async function listen(replies: ReturnType<typeof createConsumer>) {
    for (;;) {
      const record = replies.peek();

      if (!record) {
        await replies.wait();
        continue;
      }

      const id = record.stream >> KIND_BITS;
      const kind = record.stream & ((1 << KIND_BITS) - 1);

      if (kind === FROM_VIDEO.frame) {
        payload.set(record.data);
        const module = words[FRAME.module] ?? 0;
        // The memory comes by message, which may come after the module's first frame.
        if (open.has(id) && !loaded[module]) await memories[module]?.promise;
      }

      try {
        receive(record, id, kind);
      } catch (e) {
        open.get(id)?.events.error(e instanceof Error ? e : new Error(String(e)));
      }

      replies.release();
    }
  }

  function message({ data }: MessageEvent<FromVideo>) {
    loaded[data.module] = data.memory;
    memories[data.module]?.resolve(data.memory);
  }

  return { listen, message };
}

// A decoder that fails with `failure` at its first packet.
function failing(failure: Error): Decoder {
  return {
    decode() {
      throw failure;
    },
    flush: async () => {},
    queued: () => 0,
    reading: () => false,
    close() {},
  };
}

function createDecoder(
  w: Wasm,
  p: VideoParams,
  events: DecoderEvents,
  ring: SharedArrayBuffer,
): Decoder {
  const { state, open, post, record, put } = w;
  const module = p.decoder === "video" || p.decoder === "video-ext" ? p.decoder : undefined;
  // No module decodes it, or the worker has failed: it fails at its first packet.
  if (!module) return failing(new Error(`${p.codec}: no decoder for this codec`));
  if (state.failed) return failing(state.failed);
  const id = state.next++;
  const opened: Open = { events, queued: 0, reading: false };
  open.set(id, opened);
  // Posted before the open record, as the worker's open waits for the ring.
  post({ type: "packets", id, ring });
  const [num, den] = p.timeBase;
  const opening = record((id << KIND_BITS) | TO_VIDEO.open);
  opening.pts = BigInt(num);
  opening.dts = BigInt(den);
  opening.duration = VIDEO_MODULES.indexOf(module);
  opening.data = p.params;
  opening.size = p.params.length;
  put(opening);
  const place: Place = { start: 0, size: 0, part: PART.whole };
  // A packet record's payload, filled from `place`.
  const words = new Int32Array(PLACE.bytes / 4);
  const where = new Uint8Array(words.buffer);

  return {
    place,
    // Sends where the record at `place` is, not its bytes.
    decode({ dts, duration, flags }, pts) {
      const packet = record((id << KIND_BITS) | TO_VIDEO.packet);
      packet.flags = flags;
      packet.pts = pts;
      packet.dts = dts;
      packet.duration = duration;
      words[PLACE.start] = place.start;
      words[PLACE.size] = place.size;
      words[PLACE.part] = place.part;
      packet.data = where;
      packet.size = PLACE.bytes;
      put(packet);
      opened.reading = true;
      const whole = place.part === PART.whole || place.part === PART.last;
      if (whole) opened.queued++;
      return whole;
    },
    flush() {
      opened.flushed = Promise.withResolvers<void>();
      put(record((id << KIND_BITS) | TO_VIDEO.flush));
      return opened.flushed.promise;
    },
    queued: () => opened.queued,
    reading: () => opened.reading,
    // A flush under way ends, as VideoDecoder.close() ends one.
    close() {
      if (!open.delete(id)) return;
      opened.flushed?.reject(new DOMException("closed", "AbortError"));
      put(record((id << KIND_BITS) | TO_VIDEO.close));
    },
  };
}

/**
 * Makes decoders that run in the worker `start` starts, by default the bundled `video.worker.js`
 * next to this file; its `new URL` is written out in full so that a bundler finds the worker.
 * Records go to the worker through a ring of `capacity` bytes, a packet's as its place in its
 * packet ring.
 */
export function createWasmVideo(
  start = () => new Worker(new URL("./video.worker.js", import.meta.url), { type: "module" }),
  capacity = TO_CAPACITY,
) {
  const state = {
    // The worker and the ring to it, once it is started.
    thread: undefined as Worker | undefined,
    records: undefined as Producer | undefined,
    next: 0,
    failed: undefined as Error | undefined,
  };
  const open = new Map<number, Open>();
  const none = new Uint8Array(0);

  function record(stream: number) {
    const { packet } = worker();
    packet.stream = stream;
    packet.flags = 0;
    packet.pts = 0n;
    packet.dts = 0n;
    packet.duration = 0;
    packet.data = none;
    packet.offset = 0;
    packet.size = 0;
    return packet;
  }

  function put(packet: OutgoingPacket) {
    if (!worker().offer(packet)) throw new Error("video decode worker: its ring is full");
  }

  function giveBack(frame: number, packed: bigint, module: number) {
    const packet = record(TO_VIDEO.release);
    packet.flags = frame;
    packet.pts = packed;
    packet.duration = module;
    put(packet);
  }

  const replies = createReplies(open, giveBack);

  // The ring to the worker, which is started on first use with its rings, so a page that plays
  // only what WebCodecs decodes never makes them. Its failure fails every decoder, and every one
  // after.
  function worker() {
    if (state.records) return state.records;
    const to = createRing(capacity);
    const from = createRing(FROM_CAPACITY);
    const records = createProducer(to);
    const started = start();
    started.addEventListener("message", replies.message);

    started.addEventListener("error", (e) => {
      state.failed = new Error(`video decode worker: ${e.message}`);
      for (const decoder of open.values()) decoder.events.error(state.failed);
    });

    const begin: ToVideo = { type: "start", to, from };
    started.postMessage(begin);
    void replies.listen(createConsumer(from));
    state.thread = started;
    state.records = records;
    return records;
  }

  function post(message: ToVideo) {
    worker();
    state.thread?.postMessage(message);
  }

  const wasm: Wasm = { state, open, post, record, put };
  return {
    /** A decoder of the stream with parameters `p`, whose packets are in packet ring `ring`. */
    createDecoder: (p: VideoParams, events: DecoderEvents, ring: SharedArrayBuffer) =>
      createDecoder(wasm, p, events, ring),
  };
}

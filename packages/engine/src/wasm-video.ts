// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The render worker's decoders for the video streams WebCodecs does not decode: each stands in
// for a VideoDecoder in src/video.ts, and decodes in the video decode worker
// (src/video.worker.ts), which this starts once and keeps, so a seek or another file does not
// load its FFmpeg module again. Packets and frames go both ways through two rings, with no
// message per packet or frame (src/protocol.ts).

import type { VideoParams } from "./codec";
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
import {
  RING_CAPACITY,
  createConsumer,
  createProducer,
  createRing,
  type OutgoingPacket,
  type Packet,
} from "./ring";

// The ring to the worker: room for the packets of a decoder, which waits while the next does not
// fit (`fits`), and as much again for another's, with a sixteenth (SPARE) kept for the records
// that must always go, the frames going back above all. The ring back holds small records only.
const TO_CAPACITY = 2 * RING_CAPACITY;
const SPARE = 1 / 16;
// A frame's `packed` word as the record's pts.
const PACKED = [0n, 1n] as const;
const FROM_CAPACITY = 1 << 16;

const FORMATS: ReadonlySet<string | undefined> = new Set(PIXEL_FORMATS);
// Whether a name is one of PIXEL_FORMATS. TypeScript's DOM types know fewer than Chromium takes.
const isFormat = (v: string | undefined): v is VideoPixelFormat => FORMATS.has(v);

/**
 * A frame FFmpeg decoded, its planes still in `memory`, the decoding module's, where `layout`
 * says: uploaded from there, it is never copied on the CPU. Closing it hands it back.
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

/** A decoded frame: from WebCodecs, or from FFmpeg. */
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
   * Decodes `packet`, whose frame is due at `pts`, in the stream's time base: at `timestamp`,
   * for `duration`, in microseconds. `pts` is the packet's, or its dts where it has none.
   * Whether it has all of it: a packet larger than the room `fits` saw goes in parts, the
   * rest on later calls with the same packet, each once it `fits`.
   */
  decode(packet: Packet, pts: bigint, timestamp: number, duration: number): boolean;
  /** Resolves once every packet is decoded and its frames are out. */
  flush(): Promise<void>;
  /** Packets handed over and not yet decoded. */
  queued(): number;
  /**
   * Whether a packet of `size` bytes, or its next part, can be handed over now; if not, one
   * decoded makes room.
   */
  fits(size: number): boolean;
  close(): void;
}

interface Open {
  events: DecoderEvents;
  queued: number;
  // Made by a flush, so a close without one rejects nothing no one awaits.
  flushed?: PromiseWithResolvers<void>;
  // Part of a packet is in the worker's ring, the rest waiting for room.
  handing: boolean;
  // Whether a `roomFor` waits for the rest of the packet, so one at a time does.
  waiting: boolean;
}

type Producer = ReturnType<typeof createProducer>;

// Hands frame `frame` back to the `module`th module, which decoded it; `packed` if the worker
// packed it into a buffer of its own.
type GiveBack = (frame: number, packed: bigint, module: number) => void;

// What the decoders share: the open ones by id, the next id, the worker's failure, the ring to
// the worker of `capacity` bytes, and how records go into it.
interface Wasm {
  state: { next: number; failed: Error | undefined };
  open: Map<number, Open>;
  capacity: number;
  worker: () => Producer;
  /** The record to fill, of `stream`, its other fields cleared, for `put`. */
  record: (stream: number) => OutgoingPacket;
  /** Writes a record that must go: one that does not fit means the spare room is spent. */
  put: (packet: OutgoingPacket) => void;
}

// The frame in the payload that `words` and `doubles` view, from the module whose memory is
// `memory`, as a frame that goes back to it with `giveBack` once closed. Pointers are unsigned,
// past 2 GiB too.
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
      // Closed once it has gone: a ring that has no room for it throws, and leaves it open.
      giveBack(frame, packed, module);
      own.closed = true;
    },
  };
}

// The side that takes the worker's records, for the decoders in `open`; frames go back with
// `giveBack`.
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

  // Hands the frame in the payload back to the module that decoded it.
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
      // A packet decoded, of any decoder, closed ones too, makes room in the ring for every one.
      for (const each of open.values()) each.events.dequeue();
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
    fits: () => true,
    close() {},
  };
}

/** A decoder of the stream with parameters `p`, which an FFmpeg module decodes. */
function createDecoder(w: Wasm, p: VideoParams, events: DecoderEvents): Decoder {
  const { state, open, capacity, worker, record, put } = w;
  const module = p.decoder === "video" || p.decoder === "video-ext" ? p.decoder : undefined;
  // No module decodes it, or the worker has failed: it fails at its first packet.
  if (!module) return failing(new Error(`${p.codec}: no decoder for this codec`));
  if (state.failed) return failing(state.failed);
  const id = state.next++;
  const decoder: Open = { events, queued: 0, handing: false, waiting: false };
  open.set(id, decoder);
  const [num, den] = p.timeBase;
  const opening = record((id << KIND_BITS) | TO_VIDEO.open);
  opening.pts = BigInt(num);
  opening.dts = BigInt(den);
  opening.duration = VIDEO_MODULES.indexOf(module);
  opening.data = p.params;
  opening.size = p.params.length;
  put(opening);

  // Wakes the decode loop once the next part of a packet of `size` bytes fits: the worker frees
  // each piece as it copies it, with no packet decoded to say so. The flag goes up before the
  // count is read, so a piece freed after the check moves the count.
  async function roomFor(size: number) {
    const records = worker();
    decoder.waiting = true;
    records.waitingForRoom(true);

    for (;;) {
      const seen = records.bell();
      if (!open.has(id) || records.hasRoom(size, capacity * SPARE)) break;
      await records.moved(seen);
    }

    records.waitingForRoom(false);
    decoder.waiting = false;
    if (open.has(id)) events.dequeue();
  }

  return {
    // Copied from the packet ring into the worker's, which `fits` has made room in.
    decode({ data, dts, duration, flags }, pts) {
      const packet = record((id << KIND_BITS) | TO_VIDEO.packet);
      packet.flags = flags;
      packet.pts = pts;
      packet.dts = dts;
      packet.duration = duration;
      packet.data = data;
      packet.size = data.length;
      decoder.handing = !worker().offer(packet, capacity * SPARE);

      if (decoder.handing) {
        if (!decoder.waiting) void roomFor(data.length);
        return false;
      }

      decoder.queued++;
      return true;
    },
    flush() {
      decoder.flushed = Promise.withResolvers<void>();
      put(record((id << KIND_BITS) | TO_VIDEO.flush));
      return decoder.flushed.promise;
    },
    queued: () => decoder.queued,
    fits: (size) => worker().hasRoom(size, capacity * SPARE),
    // A flush under way ends, as VideoDecoder.close() ends one.
    close() {
      if (!open.delete(id)) return;
      decoder.flushed?.reject(new DOMException("closed", "AbortError"));

      if (decoder.handing && !worker().abandon()) {
        throw new Error("video decode worker: its ring is full");
      }

      put(record((id << KIND_BITS) | TO_VIDEO.close));
    },
  };
}

/**
 * The decoders, in the worker `start` starts: the bundled src/video.worker.ts next to this
 * file, written out as is so that a bundler finds the worker. Packets go to it through a ring of
 * `capacity` bytes.
 */
export function createWasmVideo(
  start = () => new Worker(new URL("./video.worker.js", import.meta.url), { type: "module" }),
  capacity = TO_CAPACITY,
) {
  const state = {
    // The ring to the worker, once it is started.
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
    state.records = records;
    return records;
  }

  const wasm: Wasm = { state, open, capacity, worker, record, put };
  return {
    createDecoder: (p: VideoParams, events: DecoderEvents) => createDecoder(wasm, p, events),
  };
}

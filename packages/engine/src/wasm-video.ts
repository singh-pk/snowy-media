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
import { RING_CAPACITY, createConsumer, createProducer, createRing, type Packet } from "./ring";

// The ring to the worker: room for the packets of a decoder, which waits while the next does not
// fit (`fits`), and as much again for another's, with SPARE kept for the records that must
// always go, the frames going back above all. The ring back holds small records only.
const TO_CAPACITY = 2 * RING_CAPACITY;
const SPARE = 1 << 20;
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
export interface SharedFrame {
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
   */
  decode(packet: Packet, pts: bigint, timestamp: number, duration: number): void;
  /** Resolves once every packet is decoded and its frames are out. */
  flush(): Promise<void>;
  /** Packets handed over and not yet decoded. */
  queued(): number;
  /** Whether a packet of `size` bytes can be handed over now; if not, one decoded makes room. */
  fits(size: number): boolean;
  close(): void;
}

interface Open {
  events: DecoderEvents;
  queued: number;
  flushed: PromiseWithResolvers<void>;
}

/**
 * The decoders, in the worker `start` starts: the bundled src/video.worker.ts next to this
 * file, written out as is so that a bundler finds the worker.
 */
export function createWasmVideo(
  start = () => new Worker(new URL("./video.worker.js", import.meta.url), { type: "module" }),
) {
  const state = {
    // The ring to the worker, once it is started.
    records: undefined as ReturnType<typeof createProducer> | undefined,
    next: 0,
    failed: undefined as Error | undefined,
  };
  const open = new Map<number, Open>();
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
  const dequeue = (decoder: Open) => decoder.events.dequeue();

  // Writes a record that must go: one that does not fit means the spare room is spent.
  function put(
    stream: number,
    flags = 0,
    pts = 0n,
    dts = 0n,
    duration = 0,
    data: Uint8Array = payload,
    size = 0,
  ) {
    if (!worker().offer(stream, flags, pts, dts, duration, data, 0, size)) {
      throw new Error("video decode worker: its ring is full");
    }
  }

  // Hands the frame in the payload back to the module that decoded it.
  function release() {
    const frame = (words[FRAME.frame] ?? 0) >>> 0;
    put(TO_VIDEO.release, frame, PACKED[words[FRAME.packed] ?? 0], 0n, words[FRAME.module]);
  }

  // The frame in the payload, from the module whose memory is `memory`, as a frame that goes
  // back to it once closed. Pointers are unsigned, past 2 GiB too.
  function shared(memory: WebAssembly.Memory): SharedFrame {
    const frame = (words[FRAME.frame] ?? 0) >>> 0;
    const packed = PACKED[words[FRAME.packed] ?? 0];
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
      release();
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
        put(TO_VIDEO.release, frame, packed, 0n, module);
        own.closed = true;
      },
    };
  }

  // Hands record `record` of decoder `id` from the worker to it; a frame's payload is in
  // `payload` already.
  function receive(record: Packet, id: number, kind: number) {
    const decoder = open.get(id);

    if (kind === FROM_VIDEO.frame) {
      const memory = loaded[words[FRAME.module] ?? 0];
      // A decoder closed since: nothing takes it, so it goes back at once.
      if (memory && decoder) decoder.events.output(shared(memory));
      else release();
    } else if (kind === FROM_VIDEO.decoded) {
      if (decoder) decoder.queued--;
      // A packet decoded, of any decoder, closed ones too, makes room in the ring for every one.
      open.forEach(dequeue);
    } else if (kind === FROM_VIDEO.failed) {
      reason.set(record.data);
      decoder?.events.error(new Error(text.decode(reason.subarray(0, record.data.length))));
    } else {
      decoder?.flushed.resolve();
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

  // The ring to the worker, which is started on first use with its rings, so a page that plays
  // only what WebCodecs decodes never makes them. Its failure fails every decoder, and every one
  // after.
  function worker() {
    if (state.records) return state.records;
    const to = createRing(TO_CAPACITY);
    const from = createRing(FROM_CAPACITY);
    const records = createProducer(to);
    const started = start();
    started.addEventListener("message", message);

    started.addEventListener("error", (e) => {
      state.failed = new Error(`video decode worker: ${e.message}`);
      for (const decoder of open.values()) decoder.events.error(state.failed);
    });

    const begin: ToVideo = { type: "start", to, from };
    started.postMessage(begin);
    void listen(createConsumer(from));
    state.records = records;
    return records;
  }

  /** A decoder of the stream with parameters `p`, which an FFmpeg module decodes. */
  function createDecoder(p: VideoParams, events: DecoderEvents): Decoder {
    const module = p.decoder === "video" || p.decoder === "video-ext" ? p.decoder : undefined;

    // No module decodes it, or the worker has failed: it fails at its first packet.
    const failure = module ? state.failed : new Error(`${p.codec}: no decoder for this codec`);

    if (!module || failure) {
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

    const id = state.next++;
    const flushed = Promise.withResolvers<void>();
    const decoder: Open = { events, queued: 0, flushed };
    open.set(id, decoder);
    const [num, den] = p.timeBase;
    const index = VIDEO_MODULES.indexOf(module);
    put(
      (id << KIND_BITS) | TO_VIDEO.open,
      0,
      BigInt(num),
      BigInt(den),
      index,
      p.params,
      p.params.length,
    );

    return {
      // Copied from the packet ring into the worker's, which `fits` has made room in.
      decode(packet, pts) {
        const { data, dts, duration, flags } = packet;
        decoder.queued++;
        put((id << KIND_BITS) | TO_VIDEO.packet, flags, pts, dts, duration, data, data.length);
      },
      flush() {
        put((id << KIND_BITS) | TO_VIDEO.flush);
        return decoder.flushed.promise;
      },
      queued: () => decoder.queued,
      fits: (size) => worker().hasRoom(size, SPARE),
      // A flush under way ends, as VideoDecoder.close() ends one.
      close() {
        if (!open.delete(id)) return;
        decoder.flushed.reject(new DOMException("closed", "AbortError"));
        put((id << KIND_BITS) | TO_VIDEO.close);
      },
    };
  }

  return { createDecoder };
}

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Code for the test and benchmark pages, bundled by serve.ts and imported from PAGE: the
// packet ring and the hash test/fixtures/expected.json records for a stream's packets, and
// the audio output with a player that renders it offline; a video stream's first packet and
// the check of its decoder config; the video output, drawing into a canvas it reads back; and
// what a playing engine shows.

import { AV_NOPTS_VALUE, AV_PKT_FLAG_KEY } from "@snowy-media/ffmpeg/core";
import { createAudioOutput } from "../../src/audio";
import { colorSpace, type VideoParams, videoConfig } from "../../src/codec";
import { createCompositor, createRoute, type Route } from "../../src/compositor";
import { createPcmControl, createPcmRing } from "../../src/pcm";
import type { FromMedia, ToMedia } from "../../src/protocol";
import { createConsumer, createRing, END, FAILED, RING_CAPACITY } from "../../src/ring";
import { createVideoOutput } from "../../src/video";
import { createWasmVideo } from "../../src/wasm-video";
import { PCM_CHANNELS, PCM_RATE, probe, SAMPLE_FRAMES } from "./audio";
import { brightnessGrid, CELL, readFrameId } from "./frame-id";

export { createAudioOutput } from "../../src/audio";
export {
  createPcmConsumer,
  createPcmControl,
  createPcmProducer,
  createPcmRing,
} from "../../src/pcm";
export { createRing, RING_CAPACITY } from "../../src/ring";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

// CRC-32 as zlib and ffprobe's -show_data_hash crc32 compute it.
function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (const b of data) c = (CRC_TABLE[(c ^ b) & 255] ?? 0) ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

// The video decode worker, started once for every render, as the render worker keeps one.
// This page is test/dist/test/support/page.js; the engine's workers are in test/dist.
const wasm = createWasmVideo(
  () => new Worker(new URL("../../video.worker.js", import.meta.url), { type: "module" }),
);
const timestamp = (t: bigint) => (t === AV_NOPTS_VALUE ? "" : String(t));

/**
 * Reads `ring` to its END record and resolves with each stream's packet count
 * and the SHA-256 of its lines `pts,dts,key,size,crc32`, without dts unless `dts`
 * (scripts/gen-fixtures.ts); or with "failed" at a FAILED record.
 */
export async function hashRing(ring: SharedArrayBuffer, dts: boolean) {
  const consumer = createConsumer(ring);
  const lines = new Map<number, string[]>();

  for (;;) {
    const packet = consumer.peek();

    if (!packet) {
      await consumer.wait();
      continue;
    }

    if (packet.stream === END) break;
    if (packet.stream === FAILED) return "failed";
    const { stream, flags, data } = packet;
    const key = flags & AV_PKT_FLAG_KEY ? 1 : 0;
    const times = dts ? `${timestamp(packet.pts)},${timestamp(packet.dts)}` : timestamp(packet.pts);
    const line = `${times},${key},${data.length},${crc32(data)}`;
    const all = lines.get(stream);
    if (all) all.push(line);
    else lines.set(stream, [line]);
    consumer.release();
  }

  const hashes: Record<number, { packets: number; packetsSha256: string }> = {};

  for (const [stream, all] of lines) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(all.join("\n")));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"));
    hashes[stream] = { packets: all.length, packetsSha256: hex.join("") };
  }

  return hashes;
}

/**
 * Plays audio stream `stream` of the file open in `media` through the engine's worklet (at
 * `worklet`) into an OfflineAudioContext of `seconds`, resampled to `channels` channels. The
 * ring holds `frames` frames, room for all of the audio, which is decoded before rendering
 * starts, so it underruns only at the end. Returns the media time of the first frame; the
 * clock's media time less its context time, every SAMPLE_FRAMES frames while it runs; the
 * clock at the end; when channel 0 clicks, in context time; and, in stereo, the probe of what
 * played (test/support/audio.ts).
 */
export async function play(
  media: ReturnType<typeof startMedia>,
  stream: number,
  {
    worklet,
    seconds,
    channels,
    frames,
  }: Record<"seconds" | "channels" | "frames", number> & {
    worklet: string;
  },
) {
  const pcm = createPcmRing(2 ** Math.ceil(Math.log2(frames)), channels, PCM_RATE);
  const control = createPcmControl(pcm);
  const length = seconds * PCM_RATE;
  const context = new OfflineAudioContext({
    numberOfChannels: channels,
    length,
    sampleRate: PCM_RATE,
  });
  await createAudioOutput(context, pcm, worklet);
  // No packets: the ring only gets the END record.
  const ring = createRing(64);
  const audio = { stream, pcm, preroll: 0 };
  await media.request({ type: "demux", ring, streams: [], from: 0, audio });
  const offsets: number[] = [];

  // Samples the clock, which only the audio thread moves, with rendering suspended at
  // `frame`; the next suspend is set before it resumes.
  async function sample(frame: number) {
    if (frame >= length) return;
    await context.suspend(frame / PCM_RATE);
    const clock = control.read();
    if (clock.playing) offsets.push(clock.pts - clock.time);
    const next = sample(frame + SAMPLE_FRAMES);
    await context.resume();
    await next;
  }

  const sampling = sample(SAMPLE_FRAMES);
  const buffer = await context.startRendering();
  await sampling;
  const { pts, playing } = control.read();
  const left = buffer.getChannelData(0);
  const clicks: number[] = [];

  for (let i = 0; i < left.length; i++) {
    if (Math.abs(left[i] ?? 0) < 0.3) continue;
    clicks.push(i / PCM_RATE);
    i += PCM_RATE / 2;
  }

  const planes = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  const probed =
    channels === PCM_CHANNELS
      ? probe(frames * channels, (i) => planes[i % channels]?.[Math.floor(i / channels)] ?? 0)
      : [];
  return { start: control.start(), offsets, end: { pts, playing }, clicks, probe: probed };
}

/** Starts the media worker at `url`, as a function per request; an error reply rejects. */
export function startMedia(url: string) {
  const worker = new Worker(url, { type: "module" });
  let next = 0;

  function request(message: DistributiveOmit<ToMedia, "id">, transfer: Transferable[] = []) {
    const id = next++;

    return new Promise<FromMedia>((resolve, reject) => {
      worker.addEventListener("message", function reply(e: MessageEvent<FromMedia>) {
        // Events before the reply, such as `buffered`, are not it.
        if (e.data.id !== id || e.data.type === "buffered") return;
        worker.removeEventListener("message", reply);
        if (e.data.type === "error") reject(new Error(e.data.message));
        else resolve(e.data);
      });
      worker.postMessage({ ...message, id }, transfer);
    });
  }

  return { request, stop: () => worker.terminate() };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The first packet of `stream` in the file open in `media`, which stops demuxing after it. */
export async function firstPacket(media: ReturnType<typeof startMedia>, stream: number) {
  const ring = createRing(1 << 22);
  const consumer = createConsumer(ring);
  const demuxed = media.request({ type: "demux", ring, streams: [stream], from: 0 });

  for (;;) {
    const packet = consumer.peek();

    if (!packet) {
      await consumer.wait();
      continue;
    }

    if (packet.stream !== stream) throw new Error(`no packet of stream ${stream}`);
    const data = packet.data.slice();
    consumer.close();
    await demuxed;
    return data;
  }
}

// The keyframe `packet` of a stream with parameters `p` as a stream without a configuration
// record carries it: for H.264 and HEVC in Annex B, each NAL unit after a start code instead
// of its length, behind the record's parameter sets. avcC: 4 bytes, the length size, the SPS
// count, each SPS with its size, the PPS count, each PPS with its size. hvcC: 21 bytes, the
// length size, then arrays of NAL units. AV1, VP8 and VP9 packets are already the same.
function inBand(p: VideoParams, packet: Uint8Array) {
  const d = p.extradata;
  const units: Uint8Array[] = [];
  const u16 = (at: number) => ((d[at] ?? 0) << 8) | (d[at + 1] ?? 0);
  let lengthSize = 0;

  if (p.codec === "h264" && d[0] === 1) {
    lengthSize = ((d[4] ?? 0) & 3) + 1;
    let at = 5;

    for (const mask of [31, 255]) {
      const count = (d[at++] ?? 0) & mask;

      for (let i = 0; i < count; i++) {
        units.push(d.subarray(at + 2, at + 2 + u16(at)));
        at += 2 + u16(at);
      }
    }
  } else if (p.codec === "hevc" && d.length >= 23) {
    lengthSize = ((d[21] ?? 0) & 3) + 1;
    let at = 23;

    for (let a = 0; a < (d[22] ?? 0); a++) {
      const count = u16(at + 1);
      at += 3;

      for (let i = 0; i < count; i++) {
        units.push(d.subarray(at + 2, at + 2 + u16(at)));
        at += 2 + u16(at);
      }
    }
  }

  if (!lengthSize) return packet;

  for (let at = 0; at + lengthSize <= packet.length;) {
    let size = 0;
    for (let i = 0; i < lengthSize; i++) size = size * 256 + (packet[at + i] ?? 0);
    units.push(packet.subarray(at + lengthSize, at + lengthSize + size));
    at += lengthSize + size;
  }

  const out: number[] = [];
  for (const unit of units) out.push(0, 0, 0, 1, ...unit);
  return new Uint8Array(out);
}

// The frame number (test/support/frame-id.ts) of the frame a decoder configured with
// `config` decodes from `keyframe`.
async function decodeFrameId(config: VideoDecoderConfig, keyframe: Uint8Array) {
  const decoded = Promise.withResolvers<VideoFrame>();
  const decoder = new VideoDecoder({ output: decoded.resolve, error: decoded.reject });
  decoder.configure(config);
  decoder.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data: keyframe }));
  const flushed = decoder.flush();
  const frame = await decoded.promise;
  await flushed;
  decoder.close();
  const colour = frame.colorSpace.toJSON();
  const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2D context");
  context.drawImage(frame, 0, 0);
  frame.close();
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  return { id: readFrameId(data, canvas.width * 4, 4), colour };
}

/**
 * The decoder config of a stream with parameters `p` and first packet `keyframe`, whether
 * the browser's VideoDecoder takes it, and if it does, the frame number and colour space of
 * the frame it decodes, and the colour space the stream states as FFmpeg `names` it; and the
 * frame number for the stream as it would be without a configuration record, its parameter
 * sets in band.
 */
export async function checkVideoConfig(
  p: VideoParams,
  keyframe: Uint8Array,
  names: Parameters<typeof colorSpace>[0],
) {
  const config = videoConfig(p, keyframe);
  const inBandKeyframe = inBand(p, keyframe);
  const inBandConfig = videoConfig({ ...p, extradata: new Uint8Array() }, inBandKeyframe);
  const { supported = false } = await VideoDecoder.isConfigSupported(config);
  const result = { codec: config.codec, inBandCodec: inBandConfig.codec, supported };
  const none = { id: undefined, inBandId: undefined, colour: undefined, stated: undefined };
  if (!supported) return { ...result, ...none };
  const { id, colour } = await decodeFrameId(config, keyframe);
  const { id: inBandId } = await decodeFrameId(inBandConfig, inBandKeyframe);
  // The colour the stream states, as the decoded frame should carry it.
  const stated = colorSpace(names);
  return { ...result, id, inBandId, colour, stated };
}

/**
 * The first frame of video stream `stream` of the file open in `media`, with parameters `p`,
 * decoded with WebCodecs and drawn at its size through the compositor both ways: from its
 * planes, and the way its measured route goes. Returns the route, and how far the two drawings
 * are apart in 8-bit levels, at the median and the 95th percentile of the channels.
 */
export async function compareRoutes(
  media: ReturnType<typeof startMedia>,
  stream: number,
  p: VideoParams,
) {
  const keyframe = await firstPacket(media, stream);
  const decoded = Promise.withResolvers<VideoFrame>();
  const decoder = new VideoDecoder({ output: decoded.resolve, error: decoded.reject });
  decoder.configure(videoConfig(p, keyframe));
  decoder.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data: keyframe }));
  const flushed = decoder.flush();
  const frame = await decoded.promise;
  await flushed;
  decoder.close();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no GPU adapter");
  const device = await adapter.requestDevice();
  const { displayWidth: width, displayHeight: height } = frame;
  const canvas = new OffscreenCanvas(width, height);
  const webgpu = canvas.getContext("webgpu");
  if (!(webgpu instanceof GPUCanvasContext)) throw new Error("no WebGPU context");
  const context = webgpu;
  const format = navigator.gpu.getPreferredCanvasFormat();
  const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
  context.configure({ device, format, usage, alphaMode: "opaque" });
  const compositor = createCompositor(device, context, format);
  const stride = Math.ceil((width * 4) / 256) * 256;
  const buffer = device.createBuffer({
    size: stride * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  // The canvas once `frame` is drawn the way `route` goes, a row `stride` bytes long.
  async function drawn(route: Route) {
    const picture = await compositor.upload(frame.clone(), route);
    compositor.draw(picture, p.matrix);
    picture.close();
    const encoder = device.createCommandEncoder();
    const at = { buffer, bytesPerRow: stride };
    encoder.copyTextureToBuffer({ texture: context.getCurrentTexture() }, at, [width, height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(buffer.getMappedRange()).slice();
    buffer.unmap();
    return pixels;
  }

  try {
    const read = await drawn({ ...createRoute(p.colorSpace), via: "read" });
    const route = createRoute(p.colorSpace);
    // Measured as it goes up from its planes.
    await drawn(route);
    await compositor.measured();
    if (route.via !== "imported" && route.via !== "apple") return { via: route.via, off: [0, 0] };
    const imported = await drawn(route);
    const off: number[] = [];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width * 4; x++) {
        // Alpha is left out.
        if (x % 4 === 3) continue;
        const i = y * stride + x;
        off.push(Math.abs((read[i] ?? 0) - (imported[i] ?? 0)));
      }
    }

    off.sort((a, b) => a - b);
    const at = (q: number) => off[Math.floor(q * (off.length - 1))] ?? Infinity;
    return { via: route.via, off: [at(0.5), at(0.95)] };
  } finally {
    frame.close();
    device.destroy();
  }
}

/**
 * The error of a decoder the video decode worker fails to open: one of the stream with
 * parameters `p`, but with codec parameters FFmpeg cannot read.
 */
export async function failInWorker(p: VideoParams) {
  const failed = Promise.withResolvers<Error>();
  const events = {
    output: (f: { close(): void }) => f.close(),
    dequeue() {},
    error: failed.resolve,
  };
  const decoder = wasm.createDecoder({ ...p, params: new Uint8Array(64).fill(255) }, events);
  const data = new Uint8Array(16);
  const packet = { stream: 0, flags: AV_PKT_FLAG_KEY, pts: 0n, dts: 0n, duration: 1, data };
  decoder.decode(packet, 0n, 0, 0);
  const error = await failed.promise;
  decoder.close();
  return error.message;
}

/**
 * Plays video stream `stream` of the file open in `media` through the engine's video output
 * into a `width` × `height` canvas, showing it at each of `times` (microseconds) in turn
 * once the frames up to it are decoded. Returns, for each time, whether a new frame went up
 * and the frame number on the canvas, and the brightness grid of the first frame shown. Each
 * time is shown once its frame is uploaded; or, `ahead`, as the render worker's animation
 * frames show it: with what is up, the frame due then going up for the next.
 */
export async function render(
  media: ReturnType<typeof startMedia>,
  stream: number,
  p: VideoParams,
  {
    times,
    width,
    height,
    ahead = false,
  }: { times: number[]; width: number; height: number; ahead?: boolean },
) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no GPU adapter");
  const device = await adapter.requestDevice();
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("webgpu");
  if (!(context instanceof GPUCanvasContext)) throw new Error("no WebGPU context");
  const format = navigator.gpu.getPreferredCanvasFormat();
  // COPY_SRC, to read back what was drawn.
  const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
  context.configure({ device, format, usage, alphaMode: "opaque" });
  const ring = createRing(RING_CAPACITY);
  const demuxed = media.request({ type: "demux", ring, streams: [stream], from: 0 });
  // Wakes the wait for frames below on every change in how far decoding is.
  const decoding = { changed: () => {} };
  const compositor = createCompositor(device, context, format);
  const output = createVideoOutput(ring, p, compositor, wasm, () => decoding.changed());
  // Rows of a texture copy are a multiple of 256 bytes apart.
  const stride = Math.ceil((width * 4) / 256) * 256;
  const buffer = device.createBuffer({
    size: stride * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const shown: { drawn: boolean; id: number }[] = [];
  let grid: number[] = [];
  const failure = { error: undefined as unknown };

  async function watch() {
    try {
      await output.done;
    } catch (e) {
      failure.error = e;
      decoding.changed();
    }
  }

  // Resolves once the frames up to `time` are decoded, the end is, or decoding fails. Decoding
  // waits for the media time while the queue is full, so what is due then goes up, as on each
  // animation frame in the render worker.
  async function decoded(time: number) {
    while (output.decodedTo() < time && !output.ended() && !failure.error) {
      if (output.full()) output.present(time);
      const changed = Promise.withResolvers<void>();
      decoding.changed = changed.resolve;
      await changed.promise;
    }
  }

  void watch();

  try {
    for (const time of times) {
      await decoded(time);
      if (failure.error) throw failure.error;
      // Uploaded first, as if the render worker's animation frames waited for it; or after.
      if (!ahead) await output.prepare(time);
      const drawn = output.present(time);
      if (ahead) await output.prepare(time);

      // Nothing new on screen: the canvas still shows the last frame, which was read already.
      if (!drawn) {
        shown.push({ drawn, id: shown.at(-1)?.id ?? -1 });
        continue;
      }

      // The canvas's texture is the one just drawn until the task ends.
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: context.getCurrentTexture() },
        { buffer, bytesPerRow: stride },
        [width, height],
      );
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(buffer.getMappedRange());
      const pixels = new Uint8Array(width * height * 4);

      for (let y = 0; y < height; y++) {
        pixels.set(mapped.subarray(y * stride, y * stride + width * 4), y * width * 4);
      }

      buffer.unmap();
      // Green, the same byte in RGBA and BGRA.
      if (shown.length === 0) grid = brightnessGrid(pixels, width, height, 4, 1);
      shown.push({ drawn, id: readFrameId(pixels.subarray(1), width * 4, 4) });
    }
  } finally {
    output.close();
    await demuxed;
    device.destroy();
  }

  return { shown, grid };
}

/**
 * A handle to `blob` stored as `name` in the origin's private file system: the engine opens
 * files only through handles, and a test cannot answer a file picker.
 */
export async function fileHandle(name: string, blob: Blob) {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  return handle;
}

/**
 * The number of the frame on `canvas`, whose control an engine has, read by drawing it into
 * `reader`, a 2D context of its size.
 */
export function frameOnScreen(
  canvas: HTMLCanvasElement,
  reader: OffscreenCanvasRenderingContext2D,
) {
  reader.drawImage(canvas, 0, 0);
  const { data } = reader.getImageData(0, 0, canvas.width, CELL);
  return readFrameId(data, canvas.width * 4, 4);
}

/**
 * On each animation frame for `ms` milliseconds, the media time of engine `player` and the
 * number of the frame on `canvas` (frameOnScreen).
 */
export async function watchScreen(
  player: { readonly currentTime: number },
  canvas: HTMLCanvasElement,
  ms: number,
) {
  const reader = new OffscreenCanvas(canvas.width, canvas.height).getContext("2d");
  if (!reader) throw new Error("no 2D context");
  const until = performance.now() + ms;
  const seen: [time: number, id: number][] = [];

  while (performance.now() < until) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    seen.push([player.currentTime, frameOnScreen(canvas, reader)]);
  }

  return seen;
}

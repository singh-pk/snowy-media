// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Video output in the render worker: decodes a stream's packets from the packet ring with
// WebCodecs, or for a codec WebCodecs does not decode with FFmpeg (src/wasm-video.ts), into
// the frame queue (src/frames.ts), and shows the frame due at a given media time through the
// compositor. Decoding waits while the queue is full, its frames are a
// second ahead of the media time, or the decoder has enough packets in hand, so neither memory nor the decoder's backlog grows.

import { isRasl, makesFrame, type VideoParams, videoConfig } from "./codec";
import { createRoute, type createCompositor, type Picture } from "./compositor";
import { createDecodeTracker } from "./decoding";
import { createFrameQueue } from "./frames";
import { createConsumer, END, FAILED, KEY_FLAG, NO_TIMESTAMP } from "./ring";
import type { createWasmVideo, DecodedFrame, Decoder, DecoderEvents } from "./wasm-video";

/**
 * The bytes of decoded frames the queue holds: enough for a few 4K 10-bit frames, and many
 * more of smaller ones (docs/architecture.md#frame-queue).
 */
const FRAME_BUDGET = 1 << 26;
// Packets handed to the decoder and not yet decoded.
const DECODE_AHEAD = 8;
// How far ahead of the media time shown, in microseconds, frames are decoded: the packets come
// far further ahead, and decoding all of them would hold hundreds of frames, far past the
// frame budget and a hardware decoder's pool of frames.
const TIME_AHEAD = 1_000_000;
// How many frames are uploaded ahead of the one shown: two, so the next is up when due even
// as the clock jumps a frame, as when audio starts.
const AHEAD = 2;

// A WebCodecs decoder of the stream with parameters `p`, configured by its first packet.
function webCodecsDecoder(p: VideoParams, events: DecoderEvents): Decoder {
  const decoder = new VideoDecoder({ output: events.output, error: events.error });
  decoder.addEventListener("dequeue", events.dequeue);

  return {
    decode(packet, _pts, timestamp, duration) {
      if (decoder.state === "unconfigured") decoder.configure(videoConfig(p, packet.data));
      // The chunk copies the data, so the packet can be released at once.
      const type = packet.flags & KEY_FLAG ? "key" : "delta";
      decoder.decode(new EncodedVideoChunk({ type, timestamp, duration, data: packet.data }));
    },
    flush: () => decoder.flush(),
    queued: () => decoder.decodeQueueSize,
    fits: () => true,
    close() {
      if (decoder.state !== "closed") decoder.close();
    },
  };
}

// A frame's bytes, or as an RGBA texture when the decoder keeps it on the GPU (no format).
const frameBytes = (frame: DecodedFrame) =>
  frame.format ? frame.allocationSize() : frame.codedWidth * frame.codedHeight * 4;

/**
 * Decodes the packets of the stream with parameters `p` from `ring`, with WebCodecs or
 * `wasm`'s decoders, and shows them with `compositor`. `done` resolves once the decoder has decoded the last packet or the
 * output is closed, and rejects if decoding fails. `changed` runs on each event that may change
 * how far decoding is: a frame decoded, the decoder taking a packet, a wait for packets or for
 * the media time begun, the end decoded, and the media worker blocking while `watch`ed. `freed`
 * runs as the ring frees room for a media worker that waits, and as it closes (src/ring.ts). It
 * plays from `from` (microseconds), its packets starting at a keyframe before it: of the frames
 * before, it keeps only the last, the one due then.
 */
export function createVideoOutput(
  ring: SharedArrayBuffer,
  p: VideoParams,
  compositor: ReturnType<typeof createCompositor>,
  wasm: ReturnType<typeof createWasmVideo>,
  changed: () => void = () => {},
  freed: () => void = () => {},
  from = 0,
) {
  const consumer = createConsumer(ring, changed, freed);
  const queue = createFrameQueue(FRAME_BUDGET, frameBytes);
  const [num, den] = p.timeBase;
  // Wakes the decode loop while it waits for room; replaced each time it waits.
  const wake = { room: () => {} };
  const state = {
    shown: undefined as Picture | undefined,
    ended: false,
    // Waiting for a packet, the ring being empty.
    waiting: false,
    // The media time last shown, and the first frame's: decoding runs TIME_AHEAD past the later.
    at: -Infinity,
    // The latest frame taken as due: the ones before it are closed, so it goes up once it is
    // uploaded even if the time then stops short of it, as a pause stops the clock short of
    // the refresh it was taken for.
    due: -Infinity,
    first: -Infinity,
    // Waiting for the media time to reach the frames decoded.
    far: false,
    // Whether the decoder has had a packet, and is just past the first, where pictures that
    // lead it are left out.
    started: false,
    leading: false,
    // Where it plays from, which a scrub moves on, and whether one has.
    from,
    moved: false,
    closed: false,
  };
  const decoding = createDecodeTracker();
  // How its frames go up, measured on the first that tell (src/compositor.ts).
  const route = createRoute(p.colorSpace);
  const failed = Promise.withResolvers<never>();

  // Pictures uploaded and not yet shown, in presentation order. They are bounded by AHEAD, not by
  // bytes: `prepare` sends no more.
  const pictures = createFrameQueue<Picture>(FRAME_BUDGET, () => 0);
  // The frames uploading: their timestamps, in the order they finish in, which is presentation
  // order; the latest of them; and the last upload's end.
  const uploads = {
    stamps: [] as number[],
    latest: -Infinity,
    done: Promise.resolve(),
  };

  async function upload(frame: DecodedFrame) {
    try {
      const picture = await compositor.upload(frame, route);

      if (state.closed) {
        picture.close();
        return;
      }

      uploads.stamps.shift();
      pictures.push(picture);
      changed();
    } catch (e) {
      failed.reject(e);
    }
  }

  function send(frame: DecodedFrame) {
    uploads.stamps.push(frame.timestamp);
    uploads.latest = frame.timestamp;
    uploads.done = upload(frame);
  }

  /**
   * Uploads the latest frame due at `time` (microseconds), then the next decoded frames until
   * AHEAD (one in a scrub) are up or on their way, so they are up before they are due. Only the
   * frames that go up are uploaded: copying a 4K frame off the GPU takes milliseconds, and a scrub decodes many it
   * never shows. Resolves once uploaded.
   */
  function prepare(time: number) {
    // From a seek, nothing goes up until the frame due at its target is decoded: the frames
    // before it come first, and would flash by. Its end, as at a seek to the end, has them all.
    const sought = state.shown || state.ended || decoding.decodedTo() >= state.from;
    if (!sought) return uploads.done;
    // Before the stream's first frame, as at a seek to the start of a file whose video starts
    // later, that frame stands for the time before it.
    const due = queue.take(Math.max(time, start));

    if (due) {
      state.due = due.timestamp;
      send(due);
    }

    // A scrub holds the time at its target, where it moves on far past the frames after it:
    // one ahead, not to hold up the upload of the frame due at the next target.
    const ahead = time > state.from || !state.moved ? AHEAD : 1;

    // Only frames decoded in order: one after a gap may yet have an earlier frame decoded before
    // it.
    while (pictures.count() + uploads.stamps.length < ahead) {
      const next = queue.first();
      if (!next || next.timestamp > decoding.decodedTo()) break;
      queue.next();
      send(next);
    }

    // Taken out of the queue, frames leave room for decoding.
    wake.room();
    return uploads.done;
  }

  const events: DecoderEvents = {
    output(frame) {
      decoding.out(frame.timestamp);
      if (state.first === -Infinity) state.first = frame.timestamp;
      // Out after a later frame went up, or on its way, it could only take video back.
      if (frame.timestamp <= uploads.latest) frame.close();
      else queue.push(frame);
      if (frame.timestamp < state.from) queue.drop(state.from);
      // Decoded up to the time shown, or a scrub's target, the frame due then is known: it goes
      // up at once, not on the next animation frame.
      const at = Math.max(state.at, state.from);
      if (decoding.decodedTo() >= at) void prepare(at);
      changed();
    },
    dequeue() {
      wake.room();
      changed();
    },
    error: failed.reject,
  };
  const decoder =
    p.decoder === "webcodecs" ? webCodecsDecoder(p, events) : wasm.createDecoder(p, events);

  const micros = (t: number) => Math.round((t * num * 1e6) / den);
  const start = micros(p.start);

  // Whether every frame is decoded to TIME_AHEAD past the media time: measured from what the
  // decoder has let out, not its latest frame, so a frame it holds back is never cut off.
  const far = () => decoding.decodedTo() > Math.max(state.at, state.first) + TIME_AHEAD;

  // Resolves once there is room, or the output closes. It looks again on each wake (a frame
  // shown, the media time nearing the frames decoded, the decoder taking a packet): one wake
  // does not mean all have room.
  async function room() {
    for (;;) {
      if (state.closed) return;
      state.far = far();
      if (!state.far && !queue.full() && decoder.queued() < DECODE_AHEAD) return;
      if (state.far) changed();
      const woken = Promise.withResolvers<void>();
      wake.room = woken.resolve;
      await woken.promise;
    }
  }

  // Ends when the decoder has decoded the last packet, or at once when the output closes.
  async function run() {
    for (;;) {
      await room();
      if (state.closed) return;
      const packet = consumer.peek();

      if (!packet) {
        // Closed by the main thread, as a seek or an open stops this play, no packet comes; a
        // wait would return at once, and again, starving the stop message behind it.
        if (consumer.closed()) return;
        state.waiting = true;
        changed();
        await consumer.wait();
        state.waiting = false;
        continue;
      }

      if (packet.stream === END) break;
      if (packet.stream === FAILED) throw new Error("demuxing failed");

      // The decoder has no room for it yet; a packet decoded makes some.
      if (!decoder.fits(packet.data.length)) {
        const woken = Promise.withResolvers<void>();
        wake.room = woken.resolve;
        await woken.promise;
        continue;
      }

      const first = !state.started;
      state.started = true;

      // Started at a CRA, as after a seek, the RASL pictures after it refer to pictures the
      // decoder never had.
      if (!first && state.leading && isRasl(p, packet.data)) {
        consumer.release();
        continue;
      }

      state.leading = first;
      // A missing pts takes the dts, right for a stream without B-frames. A raw stream with
      // them has neither and is not played yet.
      const pts = packet.pts === NO_TIMESTAMP ? packet.dts : packet.pts;
      if (pts === NO_TIMESTAMP) throw new Error("a video packet has no timestamp");
      const timestamp = micros(Number(pts));
      const dts = micros(Number(packet.dts === NO_TIMESTAMP ? pts : packet.dts));
      decoding.feed(timestamp, dts, makesFrame(p, packet.data));
      decoder.decode(packet, pts, timestamp, micros(packet.duration));
      consumer.release();
    }

    await decoder.flush();
    decoding.end();
    state.ended = true;
    changed();
  }

  async function finish() {
    try {
      await run();
    } catch (e) {
      // Closing aborts a flush or a decode in progress; that is no failure.
      if (!state.closed) throw e;
    }
  }

  const done = Promise.race([finish(), failed.promise]);

  /**
   * Shows the latest picture due at media time `time` (microseconds), if it is not already on
   * screen, and closes the one it replaces; then prepares the next. Whether a new frame went
   * up: one due but still uploading goes up on a later call.
   */
  function present(time: number) {
    state.at = time;
    const picture = pictures.take(Math.max(time, start, state.due));
    // Waiting for the media time, only its nearing lets decoding on.
    if (state.far ? !far() : picture) wake.room();

    if (picture) {
      const replaced = state.shown;
      // Owned before drawing, so a draw that throws leaves it for close.
      state.shown = picture;

      try {
        compositor.draw(picture, p.matrix);
      } finally {
        replaced?.close();
      }
    }

    // Then the frames to go up next.
    void prepare(time);
    return picture !== undefined;
  }

  // Goes on to `to` (microseconds), later than where it plays from: the frames before it are
  // dropped as from a seek, and the latest due up to it goes up as it is decoded.
  function moveTo(to: number) {
    state.from = to;
    state.moved = true;
    queue.drop(to);
    // Decoded already, the frame due goes up at once, not on the next animation frame.
    if (decoding.decodedTo() >= to) void prepare(to);
  }

  /** Whether the frame due at `time` (microseconds) is the one on screen. */
  function reached(time: number) {
    // A frame due by then, still on its way up, is not on screen yet.
    const coming = Math.min(pictures.first()?.timestamp ?? Infinity, uploads.stamps[0] ?? Infinity);
    const decoded = state.ended || decoding.decodedTo() >= time;
    return state.shown !== undefined && decoded && coming > time;
  }

  /** Stops decoding and closes every frame. */
  function close() {
    state.closed = true;
    consumer.close();
    decoder.close();
    queue.clear();
    state.shown?.close();
    state.shown = undefined;
    pictures.clear();
    uploads.stamps.length = 0;
    wake.room();
  }

  return {
    done,
    present,
    moveTo,
    reached,
    close,
    /** The time, in microseconds, up to which every frame is decoded (src/decoding.ts). */
    decodedTo: decoding.decodedTo,
    /** Whether the decoder has decoded every packet. */
    ended: () => state.ended,
    prepare,
    /** Whether the frame queue is full or far enough ahead, so decoding waits for the media time. */
    full: () => queue.full() || far(),
    /** Whether it waits for packets with nothing left to decode. */
    starved: () => state.waiting && decoder.queued() === 0,
    /** Whether the packet ring's producer waits for room. */
    blocked: () => consumer.producerWaiting(),
    /** Has `changed` run when the media worker next blocks; before reading whether it is. */
    watch: () => consumer.watch(),
  };
}

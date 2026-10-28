// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Video output in the render worker: decodes a stream's packets from the packet ring with
// WebCodecs, or for a codec WebCodecs does not decode with FFmpeg (src/wasm-video.ts), into
// the frame queue (src/frames.ts), and shows the frame due at a given media time through the
// compositor. Decoding waits while the queue is full, its frames are a
// second ahead of the media time, or the decoder has enough packets in hand, so neither memory nor the decoder's backlog grows.

import { isRasl, makesFrame, type VideoParams, videoConfig } from "./codec";
import type { createCompositor } from "./compositor";
import { createRoute } from "./measure";
import type { Picture } from "./pictures";
import { createDecodeTracker } from "./decoding";
import { createFrameQueue } from "./frames";
import { createConsumer, END, FAILED, KEY_FLAG, NO_TIMESTAMP, type Packet } from "./ring";
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
      return true;
    },
    flush: () => decoder.flush(),
    queued: () => decoder.decodeQueueSize,
    reading: () => false,
    close() {
      if (decoder.state !== "closed") decoder.close();
    },
  };
}

// A frame's bytes, or as an RGBA texture when the decoder keeps it on the GPU (no format).
const frameBytes = (frame: DecodedFrame) =>
  frame.format ? frame.allocationSize() : frame.codedWidth * frame.codedHeight * 4;

/** What a video output draws with and tells; see `createVideoOutput`. */
export interface VideoOutputOptions {
  compositor: ReturnType<typeof createCompositor>;
  wasm: ReturnType<typeof createWasmVideo>;
  changed?: () => void;
  freed?: () => void;
  from?: number;
}

function createState(from: number) {
  return {
    shown: undefined as Picture | undefined,
    // Whether the canvas is black, outside a clip, with no picture shown.
    blank: false,
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
}

// What an output's parts share, but its decoder and its ring.
function createShared(
  p: VideoParams,
  compositor: VideoOutputOptions["compositor"],
  changed: () => void,
  from: number,
) {
  const [num, den] = p.timeBase;
  const micros = (t: number) => Math.round((t * num * 1e6) / den);

  return {
    p,
    compositor,
    changed,
    state: createState(from),
    queue: createFrameQueue(FRAME_BUDGET, frameBytes),
    // Pictures uploaded and not yet shown, in presentation order. They are bounded by AHEAD, not
    // by bytes: `prepare` sends no more.
    pictures: createFrameQueue<Picture>(FRAME_BUDGET, () => 0),
    // The frames uploading: their timestamps, in the order they finish in, which is
    // presentation order; the latest of them; and the last upload's end.
    uploads: { stamps: [] as number[], latest: -Infinity, done: Promise.resolve() },
    decoding: createDecodeTracker(),
    // How its frames go up, measured on the first that tell (src/measure.ts).
    route: createRoute(p.colorSpace),
    failed: Promise.withResolvers<never>(),
    // Wakes the decode loop while it waits for room; replaced each time it waits.
    wake: { room: () => {} },
    micros,
    start: micros(p.start),
  };
}

type Shared = ReturnType<typeof createShared>;

// Uploads `frame`, then queues its picture to be shown, unless the output has closed.
async function upload(o: Shared, frame: DecodedFrame) {
  try {
    const picture = await o.compositor.upload(frame, o.route);

    if (o.state.closed) {
      picture.close();
      return;
    }

    o.uploads.stamps.shift();
    o.pictures.push(picture);
    o.changed();
  } catch (e) {
    o.failed.reject(e);
  }
}

function send(o: Shared, frame: DecodedFrame) {
  o.uploads.stamps.push(frame.timestamp);
  o.uploads.latest = frame.timestamp;
  o.uploads.done = upload(o, frame);
}

/**
 * Uploads the latest frame due at `time` (microseconds), then the next decoded frames until
 * AHEAD (one in a scrub) are up or on their way, so they are up before they are due. Only the
 * frames that go up are uploaded: copying a 4K frame off the GPU takes milliseconds, and a scrub
 * decodes many it never shows. Resolves once uploaded.
 */
function prepare(o: Shared, time: number) {
  const { state, queue, decoding, uploads } = o;
  // From a seek, nothing goes up until the frame due at its target is decoded: the frames
  // before it come first, and would flash by. Its end, as at a seek to the end, has them all.
  const sought = state.shown || state.ended || decoding.decodedTo() >= state.from;
  if (!sought) return uploads.done;
  // Before the stream's first frame, as at a seek to the start of a file whose video starts
  // later, that frame stands for the time before it.
  const due = queue.take(Math.max(time, o.start));

  if (due) {
    state.due = due.timestamp;
    send(o, due);
  }

  // A scrub holds the time at its target, where it moves on far past the frames after it:
  // one ahead, not to hold up the upload of the frame due at the next target.
  const ahead = time > state.from || !state.moved ? AHEAD : 1;

  // Only frames decoded in order: one after a gap may yet have an earlier frame decoded before
  // it.
  while (o.pictures.count() + uploads.stamps.length < ahead) {
    const next = queue.first();
    if (!next || next.timestamp > decoding.decodedTo()) break;
    queue.next();
    send(o, next);
  }

  // Taken out of the queue, frames leave room for decoding.
  o.wake.room();
  return uploads.done;
}

// Where the decoder's frames, its taking a packet and its failure go.
function decoderEvents(o: Shared): DecoderEvents {
  const { state, queue, decoding } = o;

  return {
    output(frame) {
      decoding.out(frame.timestamp);
      if (state.first === -Infinity) state.first = frame.timestamp;
      // Out after a later frame went up, or on its way, it could only take video back.
      if (frame.timestamp <= o.uploads.latest) frame.close();
      else queue.push(frame);
      if (frame.timestamp < state.from) queue.drop(state.from);
      // Decoded up to the time shown, or a scrub's target, the frame due then is known: it goes
      // up at once, not on the next animation frame.
      const at = Math.max(state.at, state.from);
      if (decoding.decodedTo() >= at) void prepare(o, at);
      o.changed();
    },
    dequeue() {
      o.wake.room();
      o.changed();
    },
    error: o.failed.reject,
  };
}

// Whether every frame is decoded to TIME_AHEAD past the media time: measured from what the
// decoder has let out, not its latest frame, so a frame it holds back is never cut off.
const far = ({ decoding, state }: Shared) =>
  decoding.decodedTo() > Math.max(state.at, state.first) + TIME_AHEAD;

// Resolves on the next wake of the decode loop.
function woken(o: Shared) {
  const wake = Promise.withResolvers<void>();
  o.wake.room = wake.resolve;
  return wake.promise;
}

// An output's parts, with its decoder and the ring it reads.
type Output = Shared & {
  decoder: Decoder;
  consumer: ReturnType<typeof createConsumer>;
};

// Resolves once there is room, or the output closes. It looks again on each wake (a frame
// shown, the media time nearing the frames decoded, the decoder taking a packet): one wake
// does not mean all have room.
async function room(o: Output) {
  const { state } = o;

  for (;;) {
    if (state.closed) return;
    state.far = far(o);
    if (!state.far && !o.queue.full() && o.decoder.queued() < DECODE_AHEAD) return;
    if (state.far) o.changed();
    await woken(o);
  }
}

// Whether `packet` is a picture to leave out: started at a CRA, as after a seek, the RASL
// pictures after it refer to pictures the decoder never had.
function leftOut(o: Output, packet: Packet) {
  const { state, p } = o;
  const first = !state.started;
  state.started = true;
  if (!first && state.leading && isRasl(p, packet.data)) return true;
  state.leading = first;
  return false;
}

// Hands `packet` to the decoder, and tells the decode tracker of it once the decoder has all of
// it, due at its pts.
function hand(o: Output, packet: Packet) {
  const { p } = o;
  // A missing pts takes the dts, right for a stream without B-frames. A raw stream with
  // them has neither, and fails here.
  const pts = packet.pts === NO_TIMESTAMP ? packet.dts : packet.pts;
  if (pts === NO_TIMESTAMP) throw new Error("a video packet has no timestamp");
  const timestamp = o.micros(Number(pts));
  // Only HEVC's (RASL) and VP8's (makesFrame) data is read here, and WebCodecs decodes both, so
  // a packet read in place, without its data, never reaches either.
  if (leftOut(o, packet)) return;
  if (!o.decoder.decode(packet, pts, timestamp, o.micros(packet.duration))) return;
  const dts = o.micros(Number(packet.dts === NO_TIMESTAMP ? pts : packet.dts));
  o.decoding.feed(timestamp, dts, makesFrame(p, packet.data));
}

// Resolves once the decoder no longer reads the record handed, so it can be freed, or the
// output closes.
async function read(o: Output) {
  while (o.decoder.reading() && !o.state.closed) await woken(o);
}

// Ends when the decoder has decoded the last packet, or at once when the output closes.
async function run(o: Output) {
  const { state, consumer, decoder } = o;

  for (;;) {
    await room(o);
    if (state.closed) return;
    // A decoder that reads the record where it is, in another thread, gets it unread.
    const packet = decoder.place ? consumer.peekPlace(decoder.place) : consumer.peek();

    if (!packet) {
      // Closed by the main thread, as a seek or an open stops this play, no packet comes; a
      // wait would return at once, and again, starving the stop message behind it.
      if (consumer.closed()) return;
      state.waiting = true;
      o.changed();
      await consumer.wait();
      state.waiting = false;
      continue;
    }

    if (packet.stream === END) break;
    // The media worker reports why, to the main thread, which stops this play.
    if (packet.stream === FAILED) return;

    hand(o, packet);
    await read(o);
    // Nothing once the output has closed.
    consumer.release();
  }

  await decoder.flush();
  o.decoding.end();
  state.ended = true;
  o.changed();
}

async function finish(o: Output) {
  try {
    await run(o);
  } catch (e) {
    // Closing aborts a flush or a decode in progress; that is no failure.
    if (!o.state.closed) throw e;
  }
}

/**
 * Shows the latest picture due at media time `time` (microseconds), if it is not already on
 * screen, and closes the one it replaces; then prepares the next. Whether a new frame went
 * up: one due but still uploading goes up on a later call.
 */
function present(o: Output, time: number) {
  const { state } = o;
  state.at = time;
  const picture = o.pictures.take(Math.max(time, o.start, state.due));
  // Waiting for the media time, only its nearing lets decoding on.
  if (state.far ? !far(o) : picture) o.wake.room();

  if (picture) {
    const replaced = state.shown;
    // Owned before drawing, so a draw that throws leaves it for close.
    state.shown = picture;
    state.blank = false;

    try {
      o.compositor.draw(picture, o.p.matrix);
    } finally {
      replaced?.close();
    }
  }

  // Then the frames to go up next.
  void prepare(o, time);
  return picture !== undefined;
}

// Clears the canvas to black, outside a clip, closing the picture shown, unless it is black.
function blank(o: Output) {
  const { state } = o;
  if (state.blank) return;
  o.compositor.clear();
  state.shown?.close();
  state.shown = undefined;
  state.blank = true;
}

// Stops decoding and closes every frame.
function close(o: Output) {
  const { state } = o;
  state.closed = true;
  o.consumer.close();
  o.decoder.close();
  o.queue.clear();
  state.shown?.close();
  state.shown = undefined;
  o.pictures.clear();
  o.uploads.stamps.length = 0;
  o.wake.room();
}

/**
 * Decodes the packets of the stream with parameters `p` from `ring`, with WebCodecs or
 * `wasm`'s decoders, and shows them with `compositor`. `done` resolves once the decoder has
 * decoded the last packet, the producer has failed (it reports why itself) or the output is
 * closed, and rejects if decoding fails. `changed` runs on each event that may change
 * how far decoding is: a frame decoded, the decoder taking a packet, a wait for packets or for
 * the media time begun, the end decoded, and the media worker blocking while `watch`ed. `freed`
 * runs as the ring frees room for a media worker that waits, and as it closes (src/ring.ts). It
 * plays from `from` (microseconds), its packets starting at a keyframe before it: of the frames
 * before, it keeps only the last, the one due then.
 */
export function createVideoOutput(
  ring: SharedArrayBuffer,
  p: VideoParams,
  { compositor, wasm, changed = () => {}, freed = () => {}, from = 0 }: VideoOutputOptions,
) {
  const consumer = createConsumer(ring, changed, freed);
  const shared = createShared(p, compositor, changed, from);
  const events = decoderEvents(shared);
  const decoder =
    p.decoder === "webcodecs" ? webCodecsDecoder(p, events) : wasm.createDecoder(p, events, ring);
  const o: Output = Object.assign(shared, { decoder, consumer });
  const { state, decoding } = o;
  const done = Promise.race([finish(o), o.failed.promise]);

  /**
   * Whether a frame is on screen and none decoded and due by `time` (microseconds) is still on
   * its way up, however far decoding trails it.
   */
  function current(time: number) {
    const coming = Math.min(
      o.pictures.first()?.timestamp ?? Infinity,
      o.uploads.stamps[0] ?? Infinity,
    );
    return state.shown !== undefined && coming > time;
  }

  return {
    done,
    present: (time: number) => present(o, time),
    /** Shows black, outside a clip; the next frame `present` takes goes up as usual. */
    blank: () => blank(o),
    // Goes on to `to` (microseconds), later than where it plays from: the frames before it are
    // dropped as from a seek, and the latest due up to it goes up as it is decoded.
    moveTo(to: number) {
      state.from = to;
      state.moved = true;
      o.queue.drop(to);
      // Decoded already, the frame due goes up at once, not on the next animation frame.
      if (decoding.decodedTo() >= to) void prepare(o, to);
    },
    current,
    /** Whether the frame due at `time` (microseconds) is the one on screen. */
    reached: (time: number) => current(time) && (state.ended || decoding.decodedTo() >= time),
    /** Stops decoding and closes every frame. */
    close: () => close(o),
    /** The time, in microseconds, up to which every frame is decoded (src/decoding.ts). */
    decodedTo: decoding.decodedTo,
    /** Whether the decoder has decoded every packet. */
    ended: () => state.ended,
    prepare: (time: number) => prepare(o, time),
    /** Whether the frame queue is full or far enough ahead, so decoding waits for the media time. */
    full: () => o.queue.full() || far(o),
    /** Whether it waits for packets with nothing left to decode. */
    starved: () => state.waiting && decoder.queued() === 0,
    /** Whether the packet ring's producer waits for room. */
    blocked: () => consumer.producerWaiting(),
    /** Has `changed` run when the media worker next blocks; before reading whether it is. */
    watch: () => consumer.watch(),
  };
}

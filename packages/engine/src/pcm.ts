// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The PCM ring and the clock the AudioWorklet publishes in its header
// (docs/architecture.md#audio-and-clock). Positions count frames (one sample per channel), only
// grow, and wrap as 32-bit integers.

// Indexes of the 32-bit words in the ring's header.
const WRITE = 0;
const READ = 1;
const PRODUCER_WAITING = 2;
const CLOSED = 3;
const CHANNELS = 4;
const RATE = 5;
// The clock, under a seqlock: `SEQUENCE` is odd while the worklet writes, so a reader that sees
// it odd or changed reads again. Then the frames played and the context frame the next one plays
// at, each as two 32-bit halves, low first, and whether it is playing; every word with Atomics.
const SEQUENCE = 6;
const PLAYED = 7;
const FRAME = 9;
const PLAYING = 11;
// The producer's doorbell: a count that the consumers of both rings the producer fills, this one
// and its packet ring, add to as they free room while it waits, or close, so one wait covers both
// rings and never misses a wake-up (docs/architecture.md#audio-and-clock).
const BELL = 12;
// 1 once no more audio comes: all of it is in the ring, or there is none.
const FINISHED = 13;
// A Float64 word: the media time of the first frame, set by the producer before the first one.
// Plain, not atomic: the stores of WRITE and SEQUENCE that follow publish it, or without audio
// those of REACH, so a reader may see the time the ring was made with until a frame plays.
const START = 7;
// The output timestamp, written by the main thread under a seqlock of its own: the context time
// being heard and when, in whole microseconds as two 32-bit halves each, and whether the context
// runs; or, held, the media time heard in place of the context time.
const OUTPUT_SEQUENCE = 16;
const OUTPUT_RUNNING = 17;
const OUTPUT_TIME = 18;
const OUTPUT_AT = 20;
// How far the video's packets reach, the media time the last one demuxed ends at, in whole
// microseconds as two 32-bit halves, under a seqlock of its own: the producer writes it as it
// demuxes, and the worklet plays silence up to it once the audio is finished.
const REACH_SEQUENCE = 22;
const REACH = 23;
const STOPPED = 0;
const RUNNING = 1;
const HELD = 2;
const DATA = 128;
const HALF = 2 ** 32;

/** The name of the AudioWorkletProcessor that plays a ring (src/audio.worklet.ts). */
export const AUDIO_PROCESSOR = "snowy-audio";

export interface AudioOptions {
  ring: SharedArrayBuffer;
}

/**
 * The clock: `pts` is the media time, in seconds, of the sample that plays at context time
 * `time`, when the context renders it, before its output latency. Not exported: readers get
 * the object `createPcmControl` reuses.
 */
interface Clock {
  pts: number;
  time: number;
  /** False after an underrun, and before the first sample: the clock stops at `pts` at `time`. */
  playing: boolean;
}

/**
 * A ring of `frames` frames, a power of two, of `channels` channels at `rate` Hz, whose clock
 * reads `start` seconds until the producer says where its audio starts. Throws a `RangeError`
 * if `frames` is not a power of two, or `channels` or `rate` is not a positive integer.
 */
export function createPcmRing(frames: number, channels: number, rate: number, start = 0) {
  if (frames < 1 || (frames & (frames - 1)) !== 0) {
    throw new RangeError(`PCM ring of ${frames} frames is not a power of two`);
  }

  if (!Number.isInteger(channels) || channels < 1 || !Number.isInteger(rate) || rate < 1) {
    throw new RangeError(`PCM ring of ${channels} channels at ${rate} Hz`);
  }

  const ring = new SharedArrayBuffer(DATA + frames * channels * 4);
  const control = new Int32Array(ring, 0, DATA / 4);
  control[CHANNELS] = channels;
  control[RATE] = rate;
  new Float64Array(ring, 0, DATA / 8)[START] = start;
  return ring;
}

function views(ring: SharedArrayBuffer) {
  const control = new Int32Array(ring, 0, DATA / 4);
  const channels = control[CHANNELS] ?? 1;
  const samples = new Float32Array(ring, DATA);
  return {
    control,
    times: new Float64Array(ring, 0, DATA / 8),
    samples,
    channels,
    rate: control[RATE] ?? 0,
    capacity: samples.length / channels,
  };
}

/** The channel count and sample rate `ring` was made for. */
export function pcmFormat(ring: SharedArrayBuffer) {
  const { channels, rate } = views(ring);
  return { channels, rate };
}

function ringBell(control: Int32Array) {
  Atomics.add(control, BELL, 1);
  Atomics.notify(control, BELL);
}

// The whole number in the two 32-bit halves of `control` from `at`, low first.
const whole = (control: Int32Array, at: number) =>
  Atomics.load(control, at + 1) * HALF + (Atomics.load(control, at) >>> 0);

/**
 * The producer's side of `ring`, for a thread that may block; `blocking` runs before each
 * wait of `write` for room, after the flag that says so is raised. `write` is for a producer
 * that waits on this ring alone, as the tests' does; the media worker `offer`s, and waits on
 * the doorbell.
 */
export function createPcmProducer(ring: SharedArrayBuffer, blocking: () => void = () => {}) {
  const { control, times, samples, channels, capacity } = views(ring);

  /** Sets the media time, in seconds, of the first frame. Call it before the first write. */
  function start(seconds: number) {
    times[START] = seconds;
  }

  /** Says no more audio comes, so the worklet plays silence as far as the video reaches. */
  function finish() {
    Atomics.store(control, FINISHED, 1);
  }

  /**
   * Says the video's packets reach `seconds`, the media time the last one demuxed ends at, to
   * the microsecond. It only ever grows.
   */
  function reach(seconds: number) {
    const micros = Math.round(seconds * 1e6);
    if (micros <= whole(control, REACH)) return;
    const sequence = control[REACH_SEQUENCE] ?? 0;
    Atomics.store(control, REACH_SEQUENCE, (sequence + 1) | 0);
    Atomics.store(control, REACH, micros % HALF);
    Atomics.store(control, REACH + 1, Math.floor(micros / HALF));
    Atomics.store(control, REACH_SEQUENCE, (sequence + 2) | 0);
  }

  /**
   * Copies as many of `frames` frames of `src`, from index `offset`, as the ring has room for.
   * Returns how many, or -1 once the consumer has closed the ring, so the producer stops.
   */
  function offer(src: Float32Array, offset: number, frames: number) {
    const written = control[WRITE] ?? 0;
    const read = Atomics.load(control, READ);
    if (Atomics.load(control, CLOSED)) return -1;
    const n = Math.min(capacity - ((written - read) | 0), frames);
    const at = written & (capacity - 1);
    const first = Math.min(n, capacity - at) * channels;
    samples.set(src.subarray(offset, offset + first), at * channels);
    if (first < n * channels) samples.set(src.subarray(offset + first, offset + n * channels), 0);
    Atomics.store(control, WRITE, (written + n) | 0);
    return n;
  }

  /**
   * The doorbell's count. Read it before checking for room and pass it to `sleep` if there was
   * none, so the doorbell ringing between the check and the wait is not missed.
   */
  function bell() {
    return Atomics.load(control, BELL);
  }

  /** Waits until the doorbell rings after `seen`, at once if it already has. */
  function sleep(seen: number) {
    Atomics.wait(control, BELL, seen);
  }

  /**
   * Raises or lowers the flag that has the consumer ring the doorbell as it reads. Raised
   * before the bell is read and the ring checked, so a read after the check rings it.
   */
  function waitingForRoom(on: boolean) {
    Atomics.store(control, PRODUCER_WAITING, on ? 1 : 0);
  }

  /**
   * Copies `frames` frames of `src` from index `offset` into the ring, as room frees up. Returns
   * false once the consumer has closed the ring, so the producer stops.
   */
  function write(src: Float32Array, offset: number, frames: number) {
    let done = 0;

    while (done < frames) {
      const seen = bell();
      const n = offer(src, offset + done * channels, frames - done);
      if (n < 0) return false;
      done += n;

      if (n === 0 && Atomics.load(control, PRODUCER_WAITING)) {
        blocking();
        sleep(seen);
        waitingForRoom(false);
      } else if (n === 0) {
        waitingForRoom(true);
      }
    }

    return true;
  }

  return { start, finish, reach, offer, bell, sleep, waitingForRoom, write };
}

/** The AudioWorklet's side of `ring`: it never blocks. */
export function createPcmConsumer(ring: SharedArrayBuffer) {
  const { control, times, samples, channels, capacity, rate } = views(ring);
  // Frames played since the start, exact in a double for millions of years at any rate.
  let played = 0;
  // The context frame after the last one played, which an underrun keeps.
  let end = 0;
  // How far the video's packets reach, in microseconds, as last read whole.
  const known = { reach: 0 };

  // The reach, read without retrying, since the worklet never waits: if the media worker is
  // writing it, this returns the reach last read whole instead.
  function reachNow() {
    const sequence = Atomics.load(control, REACH_SEQUENCE);
    const reach = whole(control, REACH);
    const torn = sequence & 1 || Atomics.load(control, REACH_SEQUENCE) !== sequence;
    if (!torn) known.reach = reach;
    return known.reach;
  }

  function publish(next: number, playing: boolean) {
    const sequence = control[SEQUENCE] ?? 0;
    Atomics.store(control, SEQUENCE, (sequence + 1) | 0);
    Atomics.store(control, PLAYED, played % HALF);
    Atomics.store(control, PLAYED + 1, Math.floor(played / HALF));
    Atomics.store(control, FRAME, next % HALF);
    Atomics.store(control, FRAME + 1, Math.floor(next / HALF));
    Atomics.store(control, PLAYING, playing ? 1 : 0);
    Atomics.store(control, SEQUENCE, (sequence + 2) | 0);
  }

  // How many of `most` frames of silence, after `from` frames played, lie within the video's
  // reach: rounded up, so the clock reaches the end of the last frame. Worked out in whole
  // microseconds, so the one rounding is exact.
  function silence(most: number, from: number) {
    const span = reachNow() - Math.round((times[START] ?? 0) * 1e6);
    const reach = Math.ceil((span * rate) / 1e6);
    return Math.max(0, Math.min(most, reach - from));
  }

  /**
   * Fills `output`, one array per channel, with the next frames, and silence where the ring
   * runs out; `frame` is the context's frame of its first frame (`currentFrame`). Once the
   * audio is finished, the silence after it counts as played as far as the video reaches.
   * Publishes the clock.
   */
  function read(output: Float32Array[], frame: number) {
    const frames = output[0]?.length ?? 0;
    const at = control[READ] ?? 0;
    const open = !Atomics.load(control, CLOSED);
    const available = open ? (Atomics.load(control, WRITE) - at) | 0 : 0;
    const n = Math.min(frames, available);

    // Indexed loops: an iterator would allocate on the audio thread every quantum.
    for (let c = 0; c < output.length; c++) {
      const out = output[c];
      if (!out) continue;
      const filled = c < channels ? n : 0;
      for (let i = 0; i < filled; i++)
        out[i] = samples[((at + i) & (capacity - 1)) * channels + c] ?? 0;
      out.fill(0, filled);
    }

    if (n > 0) {
      Atomics.store(control, READ, (at + n) | 0);
      if (Atomics.load(control, PRODUCER_WAITING)) ringBell(control);
    }

    const finished = open && n < frames && Atomics.load(control, FINISHED) === 1;
    const moved = n + (finished ? silence(frames - n, played + n) : 0);
    played += moved;
    if (moved > 0) end = frame + moved;
    publish(end, moved === frames && moved > 0);
  }

  /** Whether the ring is closed: nothing will play from it again. */
  function closed() {
    return Atomics.load(control, CLOSED) === 1;
  }

  return { read, closed };
}

/** The side of `ring` for any other thread: the clock, how full it is, and stopping it. */
export function createPcmControl(ring: SharedArrayBuffer) {
  const { control, times, rate } = views(ring);
  const clock: Clock = { pts: 0, time: 0, playing: false };

  /** The clock as last published; the object is reused. */
  function read() {
    for (;;) {
      const sequence = Atomics.load(control, SEQUENCE);
      if (sequence & 1) continue;
      const played = whole(control, PLAYED);
      const frame = whole(control, FRAME);
      const playing = Atomics.load(control, PLAYING) === 1;
      if (Atomics.load(control, SEQUENCE) !== sequence) continue;
      clock.pts = (times[START] ?? 0) + played / rate;
      clock.time = frame / rate;
      clock.playing = playing;
      return clock;
    }
  }

  /**
   * The media time, in seconds, playing at context time `time`. While the clock is stopped, it
   * is the clock's `pts` from the clock's context time on, when the last frame has played, and
   * runs before then, since what plays at an earlier context time is the audio before the
   * underrun.
   */
  function mediaTime(time: number) {
    const { pts, time: at, playing } = read();
    return playing ? pts + time - at : pts + Math.min(0, time - at);
  }

  /**
   * Publishes the context's output timestamp, from the main thread: context time
   * `contextTime` is heard at `at`, in milliseconds on the clock of `performance.timeOrigin +
   * performance.now()`, which every thread shares; and whether the context is running. With
   * `held`, it publishes instead that media time (seconds) is heard, whatever the context time,
   * so a paused clock holds while the worklet's clock moves on.
   */
  function publishOutput(contextTime: number, at: number, running: boolean, held?: number) {
    const sequence = control[OUTPUT_SEQUENCE] ?? 0;
    const state = held === undefined ? (running ? RUNNING : STOPPED) : HELD;
    const time = Math.round((held ?? contextTime) * 1e6);
    const when = Math.round(at * 1e3);
    Atomics.store(control, OUTPUT_SEQUENCE, (sequence + 1) | 0);
    Atomics.store(control, OUTPUT_TIME, time % HALF);
    Atomics.store(control, OUTPUT_TIME + 1, Math.floor(time / HALF));
    Atomics.store(control, OUTPUT_AT, when % HALF);
    Atomics.store(control, OUTPUT_AT + 1, Math.floor(when / HALF));
    Atomics.store(control, OUTPUT_RUNNING, state);
    Atomics.store(control, OUTPUT_SEQUENCE, (sequence + 2) | 0);
  }

  /**
   * The media time, in seconds, heard at `at` (milliseconds, as for `publishOutput`): the
   * context time heard then, from the last output timestamp, carried forward while the context
   * runs, through the clock.
   */
  function heard(at: number) {
    for (;;) {
      const sequence = Atomics.load(control, OUTPUT_SEQUENCE);
      if (sequence & 1) continue;
      const time = whole(control, OUTPUT_TIME) / 1e6;
      const when = whole(control, OUTPUT_AT) / 1e3;
      const state = Atomics.load(control, OUTPUT_RUNNING);
      if (Atomics.load(control, OUTPUT_SEQUENCE) !== sequence) continue;
      if (state === HELD) return time;
      return mediaTime(state === RUNNING ? time + (at - when) / 1000 : time);
    }
  }

  /** Whether the last output timestamp published runs (`publishOutput`). */
  function outputRunning() {
    return Atomics.load(control, OUTPUT_RUNNING) === RUNNING;
  }

  function producerWaiting() {
    return Atomics.load(control, PRODUCER_WAITING) === 1;
  }

  /**
   * The media time, in seconds, of the first frame. Until the clock has played a frame, it may
   * still be the `start` the ring was made with.
   */
  function start() {
    return times[START] ?? 0;
  }

  /**
   * Stops the producer: its next `offer` returns -1 and `write` false, and a waiting one wakes
   * up.
   */
  function close() {
    Atomics.store(control, CLOSED, 1);
    Atomics.store(control, READ, Atomics.load(control, WRITE));
    ringBell(control);
  }

  /**
   * Wakes the producer if it waits, for the consumer of its packet ring as it frees room or
   * closes it (src/ring.ts).
   */
  function wakeProducer() {
    ringBell(control);
  }

  return {
    read,
    mediaTime,
    publishOutput,
    heard,
    outputRunning,
    producerWaiting,
    start,
    close,
    wakeProducer,
  };
}

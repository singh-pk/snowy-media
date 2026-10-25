// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The public API of @snowy-media/engine.

import { createAudioOutput } from "./audio";
import type { VideoParams } from "./codec";
import { createPcmControl, createPcmRing } from "./pcm";
import { checkMainThread, UnsupportedPlatformError } from "./platform";
import type { FromMedia, FromRender, MediaInfo, ToMedia, ToRender } from "./protocol";
import { closeRing, createRing, RING_CAPACITY } from "./ring";

export { UnsupportedPlatformError } from "./platform";
export type { MediaInfo, PlatformFeature, Track } from "./protocol";

export interface EngineOptions {
  /** The canvas the engine draws video into; the engine takes control of it. */
  canvas: HTMLCanvasElement;
}

export interface Engine {
  /**
   * Opens the file behind `handle` in place of the open one, stopping it and clearing the
   * canvas to black, and resolves with what it holds. The handle comes from
   * `showOpenFilePicker` or a drop, and may be one the app kept in IndexedDB, once
   * `handle.requestPermission` has granted reading it again; without that, it rejects with
   * the NotAllowedError of `handle.getFile`. Rejects with an AbortError if a later open is
   * called before it resolves.
   */
  open(handle: FileSystemFileHandle): Promise<MediaInfo>;
  /**
   * Plays the open file's first video and first audio track from where it is, once the
   * browser allows audio to start (after a user gesture), unless a pause comes first: once
   * video is decoded and audio buffered ahead, it starts the audio, and resolves once
   * it is heard. Rejects if playing has failed, or with an AbortError if an open stops it
   * while it starts.
   */
  play(): Promise<void>;
  /** Pauses; `play` goes on from here. Rejects if playing has failed. */
  pause(): Promise<void>;
  /**
   * Goes to `time`, in seconds, at most the duration: the frame due then is on screen once it
   * resolves, and audio goes on from there if it was playing. A play still starting goes on
   * from `time` instead; a seek that a later one replaces resolves. Rejects if playing has
   * failed, or with an AbortError if an open stops it. Paused in a hidden page, it resolves
   * once the page is shown.
   */
  seek(time: number): Promise<void>;
  /**
   * Goes to `time` as a scrub does, paused: the frame due then is on screen once it resolves,
   * as with `seek`, but calls while one is under way only replace where it goes next, so
   * however often it is called the screen follows as fast as it can decode. Forward, with no
   * keyframe on the way, it decodes on instead of starting again, showing the frames it passes.
   * Each call resolves once the frame of the last target is up; paused in a hidden page, once
   * the page is shown. Playing, it is `seek`.
   */
  fastSeek(time: number): Promise<void>;
  /** The media time, in seconds, of what is being heard and seen now. */
  readonly currentTime: number;
  /** Stops the engine's workers. */
  close(): void;
}

// The PCM ring's length at `rate`: a power of two, a second and more, so the media worker
// can demux a second of video ahead of the audio it decodes (docs/architecture.md#playback).
const pcmFrames = (rate: number) => 2 ** Math.ceil(Math.log2(rate));
// The packet ring of a file without video, which only ever carries the END record.
const NO_VIDEO_RING = 64;
// The audio buffered before it starts, in seconds, so a slow start does not underrun.
const PREROLL = 0.25;
// The output timestamp has settled once this many in a row, each newer than the last, map
// context time to performance time within SETTLED_MS of the one before. The first ones
// after output starts are estimates: Chromium moves them by up to 35 ms. Coarse
// timers may never agree, so it settles anyway after SETTLED_LIMIT newer ones.
const SETTLED_COUNT = 2;
const SETTLED_MS = 2;
const SETTLED_LIMIT = 10;
// What the PCM ring mixes to; the context's destination takes stereo everywhere.
const CHANNELS = 2;

// A hidden page starts no audio: its animation frames, and so video, wait until it is shown.
const visible = () => document.visibilityState === "visible";

// A worker that fails to load fires a plain Event, without a message.
const loadError = (e: Event, worker: string) =>
  new Error(e instanceof ErrorEvent ? e.message : `the ${worker} worker failed to load`);

// Sends `message` to `worker` and resolves with its reply, or rejects if the worker fails to load.
function request(worker: Worker, message: ToRender, transfer: Transferable[]) {
  return new Promise<FromRender>((resolve, reject) => {
    worker.addEventListener("message", (e: MessageEvent<FromRender>) => resolve(e.data), {
      once: true,
    });
    worker.addEventListener("error", (e) => reject(loadError(e, "render")), { once: true });
    worker.postMessage(message, transfer);
  });
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// The media worker, as a function per request; replies may come in any order. `buffered`
// runs when a demux request says its audio is buffered.
function createMedia() {
  const worker = new Worker(new URL("./media.worker.js", import.meta.url), { type: "module" });
  const pending = new Map<number, PromiseWithResolvers<FromMedia> & { buffered(): void }>();
  let next = 0;
  // Once set, why every request rejects: the worker failed to load, or the engine closed.
  let failed: Error | undefined;

  worker.addEventListener("message", ({ data }: MessageEvent<FromMedia>) => {
    const call = pending.get(data.id);

    if (data.type === "buffered") {
      call?.buffered();
      return;
    }

    pending.delete(data.id);
    if (data.type === "error") call?.reject(new Error(data.message));
    else call?.resolve(data);
  });

  function fail(error: Error) {
    failed ??= error;
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  }

  worker.addEventListener("error", (e) => fail(loadError(e, "media")));

  function send(
    message: DistributiveOmit<ToMedia, "id">,
    transfer: Transferable[] = [],
    buffered = () => {},
  ) {
    if (failed) return Promise.reject(failed);
    const call = Promise.withResolvers<FromMedia>();
    const id = next++;
    pending.set(id, { ...call, buffered });
    worker.postMessage({ ...message, id }, transfer);
    return call.promise;
  }

  function close() {
    worker.terminate();
    fail(new Error("the engine is closed"));
  }

  return { send, close };
}

/**
 * Starts an engine that draws into `canvas`. Rejects with an UnsupportedPlatformError naming
 * the first missing feature when the browser cannot run it.
 */
export async function createEngine({ canvas }: EngineOptions): Promise<Engine> {
  const missing = checkMainThread();
  if (missing) throw new UnsupportedPlatformError(missing);
  // Throws if the canvas is already in use, before there is a worker to stop.
  const offscreen = canvas.transferControlToOffscreen();
  const render = new Worker(new URL("./render.worker.js", import.meta.url), { type: "module" });
  // Starts loading FFmpeg while the render worker checks the GPU.
  const media = createMedia();

  try {
    const reply = await request(render, { type: "init", canvas: offscreen }, [offscreen]);
    if (reply.type === "unsupported") throw new UnsupportedPlatformError(reply.missing);
  } catch (e) {
    render.terminate();
    media.close();
    throw e;
  }

  return createPlayer(render, media);
}

// What plays: play `id`, its clock, publishing the output timestamp now, whether it may
// start and is heard, and stopping it.
interface Playback {
  id: number;
  clock: ReturnType<typeof createPcmControl>;
  publish(stopping?: number): void;
  primed(): boolean;
  drawn(): boolean;
  heard(): boolean;
  stop(): void;
}

// The engine on a render worker that is ready and a media worker.
function createPlayer(render: Worker, media: ReturnType<typeof createMedia>): Engine {
  const state = {
    opened: undefined as { info: MediaInfo; video: Record<number, VideoParams> } | undefined,
    // Made on the first play, and kept: a page may only start so many.
    context: undefined as AudioContext | undefined,
    // Set at once, so a second play while the first starts joins it.
    playback: undefined as Promise<Playback> | undefined,
    // What plays, once it has started.
    started: undefined as Playback | undefined,
    // Why playing stopped, until the next open.
    failure: undefined as Error | undefined,
    // The id of what plays, whose failures count, or -1; and the next one.
    current: -1,
    next: 0,
    // Whether the last call was play, not pause, and nothing has stopped it since: an open, a
    // failure, or a play rejecting with no seek taking over. A seek or a scrub plays on only
    // then. And how many pauses there have been, so a play knows a pause stopped it.
    playing: false,
    pauses: 0,
    // Where the next play starts, in microseconds, or where a scrub has moved the paused one
    // on to (`moved`, so its audio starts before); and how many seeks there have been.
    from: 0,
    moved: false,
    // Whether what plays has played: paused, its frame is then where the clock stopped, or a
    // frame on, not at `from`.
    played: false,
    seeks: 0,
    // How many opens there have been, so one that a later open replaces stops there.
    opens: 0,
    // The first video stream's keyframe times, in microseconds, as far as its index goes.
    index: { keyframes: [] as number[], end: -Infinity },
    // The target of the scrub under way, which it goes on to next, and the scrub.
    scrub: { to: undefined as number | undefined, running: undefined as Promise<void> | undefined },
    // How far the render worker has decoded, as it last reported, and for which play.
    video: { id: -1, ahead: false, stuck: false, drawn: false, shown: false, reached: -1 },
    closed: false,
  };
  // Wakes the waits of `until`.
  const waits = new Set<() => void>();

  // Has each wait of `until` look again; on every event that may change what it waits for.
  function changed() {
    for (const wake of waits) wake();
  }

  // Resolves once `done` returns true, which it checks now and on each change.
  async function until(done: () => boolean) {
    while (!done()) {
      const woken = Promise.withResolvers<void>();
      waits.add(woken.resolve);

      try {
        await woken.promise;
      } finally {
        waits.delete(woken.resolve);
      }
    }
  }

  document.addEventListener("visibilitychange", changed);

  render.addEventListener("message", ({ data }: MessageEvent<FromRender>) => {
    if (data.type === "video") state.video = data;
    if (data.type === "error" && data.id === state.current) fail(new Error(data.message));
    changed();
  });
  // An uncaught error in the render worker.
  render.addEventListener("error", (e) => fail(loadError(e, "render")));

  function fail(error: Error) {
    state.failure ??= error;
    state.playing = false;
    state.from = 0;
    state.moved = false;
    state.played = false;
    stop();
  }

  // Starts the open file playing into `context` from `state.from`, as play `id`.
  async function startPlayback(context: AudioContext, id: number): Promise<Playback> {
    const opened = state.opened;
    if (!opened) throw new Error("play: no file is open");
    const audio = opened.info.tracks.find((t) => t.kind === "audio");
    // The clock is the audio's, so a file without audio has none.
    if (!audio) throw new Error("play: a file without audio does not play yet");
    const video = opened.info.tracks.find((t) => t.kind === "video");
    const params = video && opened.video[video.id];
    const frames = pcmFrames(context.sampleRate);
    const from = state.from;
    const pcm = createPcmRing(frames, CHANNELS, context.sampleRate, from / 1e6);
    const clock = createPcmControl(pcm);
    // Held while it prerolls: a context made in a user gesture starts running by itself, and
    // one that played the last file still runs.
    await context.suspend();
    const node = await createAudioOutput(context, pcm);

    // An open may have stopped this play while the worklet loaded, and the media worker may
    // hold another file already.
    if (state.current !== id) {
      clock.close();
      node.disconnect();
      throw new DOMException("play: stopped while it started", "AbortError");
    }

    const ring = createRing(params ? RING_CAPACITY : NO_VIDEO_RING);

    if (params) {
      const message = { type: "play", id, ring, params, pcm, from } as const;
      render.postMessage(message satisfies ToRender);
    }

    const streams = video && params ? [video.id] : [];
    const preroll = PREROLL * context.sampleRate;
    const demux = { buffered: false, done: false };

    const demuxed = media.send(
      {
        type: "demux",
        ring,
        streams,
        from,
        audio: { stream: audio.id, pcm, preroll },
      },
      [],
      () => {
        demux.buffered = true;
        changed();
      },
    );

    const frame = { id: 0 };
    // The last output timestamp, as context minus performance milliseconds, and when; and the
    // media time heard when a pause stopped it, until a timestamp passes it.
    const output = {
      offset: Number.NaN,
      at: 0,
      agreed: 0,
      newer: 0,
      settled: false,
      stopped: Number.NaN,
    };

    // The output timestamp, for the render worker (src/pcm.ts), on every animation frame and
    // as the context stops. It runs once it has settled, and stays so until the context stops.
    // Stopped by a pause at `stopping` (performance milliseconds), it holds the media time heard
    // then until a timestamp passes it, so the clock never goes back: the last timestamp
    // is up to an audio callback older, and the frame on screen went up by it carried forward.
    function publish(stopping?: number) {
      const { contextTime = 0, performanceTime = 0 } = context.getOutputTimestamp();
      const offset = contextTime * 1000 - performanceTime;

      if (performanceTime > output.at) {
        const agrees = Math.abs(offset - output.offset) < SETTLED_MS;
        output.agreed = agrees ? output.agreed + 1 : 0;
        output.offset = offset;
        output.at = performanceTime;
        output.newer++;
      }

      const running = context.state === "running";

      // Heard no further than the worklet rendered; paused again while held, never back.
      if (stopping !== undefined && output.settled) {
        const at = clock.mediaTime(Math.min((stopping + output.offset) / 1000, clock.read().time));
        output.stopped = Number.isNaN(output.stopped) ? at : Math.max(output.stopped, at);
      }

      const agreed = output.agreed >= SETTLED_COUNT || output.newer >= SETTLED_LIMIT;
      const settled = output.settled;
      output.settled = running && (output.settled || agreed);
      if (output.settled !== settled) changed();
      if (clock.mediaTime(contextTime) >= output.stopped) output.stopped = Number.NaN;
      const held = !Number.isNaN(output.stopped);

      // A timestamp from before a pause says nothing of the one after it.
      if (!running) {
        output.agreed = 0;
        output.newer = 0;
      }

      // Held as a media time, not a context time: a suspend moves context time on by a
      // callback the worklet never renders.
      const at = performance.timeOrigin + performanceTime;
      clock.publishOutput(contextTime, at, output.settled, held ? output.stopped : undefined);
    }

    function everyFrame() {
      publish();
      frame.id = requestAnimationFrame(everyFrame);
    }

    async function watch() {
      try {
        await demuxed;
        demux.done = true;
        changed();
      } catch (e) {
        if (state.current === id) fail(e instanceof Error ? e : new Error(String(e)));
      }
    }

    // Stops both rings' producer, so the media worker is free for the next request.
    function stopPlayback() {
      cancelAnimationFrame(frame.id);
      render.postMessage({ type: "stop" } satisfies ToRender);
      clock.close();
      closeRing(ring);
      node.disconnect();
    }

    // Whether it may start, once and for good: video is decoded and audio buffered ahead, or
    // the render worker says video can get no further while the context is held, as for
    // sparse video or a short audio track. A full PCM ring is audio ahead.
    const prerolled = { done: false };

    function primed() {
      const reported = state.video.id === id ? state.video : undefined;
      const videoAhead = !params || reported?.ahead === true;
      const audioAhead = demux.buffered || demux.done;
      prerolled.done ||= (videoAhead && audioAhead) || reported?.stuck === true;
      return prerolled.done;
    }

    // Whether the frame due at the start is on screen; without video, once it may start.
    function drawn() {
      return params ? state.video.id === id && state.video.drawn : primed();
    }

    // Whether it is heard, by a settled timestamp past a pause's, and the frame on screen went
    // up by it.
    function heard() {
      const shown = !params || (state.video.id === id && state.video.shown);
      return output.settled && Number.isNaN(output.stopped) && shown;
    }

    everyFrame();
    void watch();

    return { id, clock, publish, primed, drawn, heard, stop: stopPlayback };
  }

  async function stopStarted(playback: Promise<Playback>) {
    try {
      const started = await playback;
      started.stop();
    } catch {
      // It never started; play already rejected with why.
    }
  }

  function stop() {
    if (state.playback) void stopStarted(state.playback);
    state.playback = undefined;
    state.started = undefined;
    state.current = -1;
    changed();
  }

  async function open(handle: FileSystemFileHandle) {
    const id = ++state.opens;
    const replaced = () => id !== state.opens;
    const file = await handle.getFile();
    if (replaced()) throw new DOMException("open: replaced", "AbortError");
    stop();
    render.postMessage({ type: "clear" } satisfies ToRender);
    state.failure = undefined;
    state.playing = false;
    state.opened = undefined;
    state.from = 0;
    state.moved = false;
    state.played = false;
    const reply = await media.send({ type: "open", file });
    if (reply.type !== "opened") throw new Error(`open: unexpected ${reply.type}`);
    // The later open has stopped this one, and its file is the one the media worker has open.
    if (replaced()) throw new DOMException("open: replaced", "AbortError");
    state.opened = { info: reply.info, video: reply.video };
    const video = reply.info.tracks.find((t) => t.kind === "video");
    state.index = (video && reply.index[video.id]) ?? { keyframes: [], end: -Infinity };
    return reply.info;
  }

  // What plays, started from `state.from` unless something does, and its context.
  async function begin() {
    const context = (state.context ??= new AudioContext({ latencyHint: "playback" }));

    if (!state.playback) {
      state.current = state.next++;
      state.playback = startPlayback(context, state.current);
    }

    const playback = state.playback;
    const started = await startedOrCleared(playback);
    // Unless an open stopped it while it started.
    if (state.playback === playback) state.started = started;
    return { context, started };
  }

  async function play() {
    if (state.failure) throw state.failure;
    const pauses = state.pauses;
    state.playing = true;
    state.played = true;
    state.scrub.to = undefined;

    // Moved on by a scrub, its audio starts before where it is: it starts again from there.
    if (state.moved) {
      stop();
      state.moved = false;
      state.seeks++;
    }

    // A seek while it starts stops what it starts, and it goes on with the seek's.
    for (;;) {
      const seeks = state.seeks;

      try {
        await playOnce();
        return;
      } catch (e) {
        if (state.seeks === seeks || state.failure) {
          state.playing = false;
          throw e;
        }

        // A pause that came meanwhile wins; whatever else stopped it rejects this play too.
        if (!state.playing && state.pauses !== pauses) return;
        if (!state.playing) throw e;
      }
    }
  }

  async function playOnce() {
    const { context, started } = await begin();
    const stopped = () => state.current !== started.id;

    // Rejects if an open or a failure stopped it while it waited.
    const check = () => {
      if (stopped()) throw state.failure ?? new DOMException("play: stopped", "AbortError");
    };

    await until(() => stopped() || !state.playing || (started.primed() && visible()));
    check();
    // Unless a pause came while it started.
    if (!state.playing) return;
    // Not awaited alone: without a user gesture it stays pending until one, and a pause or a
    // stop meanwhile settles this play.
    const resumed = resume(context);
    await until(() => stopped() || !state.playing || resumed.failed || started.heard());
    if (resumed.failed) throw resumed.error;
    check();
  }

  // Resumes `context`; whether it failed, and why, on the change that says so.
  function resume(context: AudioContext) {
    const resumed = { failed: false, error: undefined as unknown };

    async function run() {
      try {
        await context.resume();
      } catch (e) {
        resumed.failed = true;
        resumed.error = e;
        changed();
      }
    }

    void run();
    return resumed;
  }

  // `playback` once it has started; if it fails to, it is no longer what plays.
  async function startedOrCleared(playback: Promise<Playback>) {
    try {
      return await playback;
    } catch (e) {
      if (state.playback === playback) state.playback = undefined;
      throw e;
    }
  }

  async function pause() {
    if (state.failure) throw state.failure;
    state.playing = false;
    state.pauses++;
    changed();
    await state.context?.suspend();
    // Published now, not on the next animation frame, so the clock holds once pause resolves,
    // in a hidden page too; at the time heard now, as far as the render worker has drawn.
    state.started?.publish(performance.now());
  }

  // `time` in seconds as a start in microseconds, at most the duration; or what is wrong.
  function target(time: number) {
    if (state.failure) throw state.failure;
    const duration = state.opened?.info.duration;
    if (!state.opened) throw new Error("seek: no file is open");
    if (!Number.isFinite(time) || time < 0) throw new RangeError(`seek: ${time} s`);
    return Math.min(Math.round(Math.min(time, duration ?? time) * 1e6), Number.MAX_SAFE_INTEGER);
  }

  async function seek(time: number) {
    const to = target(time);
    state.scrub.to = undefined;
    return go(to);
  }

  async function fastSeek(time: number) {
    const to = target(time);
    if (state.playing) return seek(time);
    state.scrub.to = to;
    state.scrub.running ??= scrub();
    return state.scrub.running;
  }

  // Goes to each target a scrub is given in turn, the last one each time, until none is left.
  async function scrub() {
    try {
      for (let to = state.scrub.to; to !== undefined; to = state.scrub.to) {
        state.scrub.to = undefined;
        await (movable(to) ? move(to) : go(to));
      }
    } finally {
      state.scrub.running = undefined;
    }
  }

  // Whether the paused play can go on to `to` by decoding on: it has not played, so the frame
  // up is the one due at `from`, `to` is ahead of it, and the index says no keyframe comes up to
  // it, which starting again would decode from instead.
  function movable(to: number) {
    const { started, from } = state;
    if (state.played || !started?.drawn() || state.video.id !== started.id) return false;
    const { keyframes, end } = state.index;
    if (to < from || to > end) return false;
    return !keyframes.some((k) => k > from && k <= to);
  }

  // Moves the paused play on to `to` (microseconds); resolves once its frame is up.
  async function move(to: number) {
    const id = state.current;
    const seeks = state.seeks;
    // Its audio is never heard, as a play starts again from the scrub: stopped, it no longer
    // fills, so the media worker demuxes on for the video however far the scrub goes.
    if (!state.moved) state.started?.clock.close();
    state.from = to;
    state.moved = true;
    render.postMessage({ type: "scrub", id, to } satisfies ToRender);
    await until(
      () => state.current !== id || (state.video.id === id && state.video.reached === to),
    );
    // Stopped: by a seek or a play, which take over, or else by an open or a failure.
    if (state.current === id || (state.seeks !== seeks && !state.failure)) return;
    throw state.failure ?? new DOMException("seek: stopped", "AbortError");
  }

  // Starts playing again from `from` (microseconds); paused, resolves once the frame due then is
  // drawn.
  async function go(from: number) {
    stop();
    state.from = from;
    state.moved = false;
    state.played = false;
    const seeks = ++state.seeks;

    // Paused while it starts, it goes on as a paused seek: its frame up before it resolves.
    if (state.playing) {
      await play();
      if (state.playing) return;
    }

    try {
      const { started } = await begin();
      await until(() => state.current !== started.id || started.drawn());
      if (state.current === started.id) return;
    } catch (e) {
      if (state.seeks === seeks) throw e;
    }

    // Stopped: by a later seek, which takes over, or else by an open or a failure.
    if (state.seeks === seeks || state.failure) {
      throw state.failure ?? new DOMException("seek: stopped", "AbortError");
    }
  }

  function close() {
    if (state.closed) return;
    state.closed = true;
    document.removeEventListener("visibilitychange", changed);
    stop();
    void state.context?.close();
    render.terminate();
    media.close();
  }

  return {
    open,
    play,
    pause,
    seek,
    fastSeek,
    get currentTime() {
      const now = performance.timeOrigin + performance.now();
      if (state.moved || !state.started) return state.from / 1e6;
      return state.started.clock.heard(now);
    },
    close,
  };
}

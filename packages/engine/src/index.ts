// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0

import { type Clip, clipsOf, type Composition, endOf, startOf } from "./composition";
import { checkMainThread, UnsupportedPlatformError } from "./platform";
import {
  type Asset,
  type Playback,
  type PlaybackHost,
  type Played,
  startPlayback,
  type VideoReport,
} from "./playback";
import type { FromMedia, FromRender, MediaInfo, Opened, ToMedia, ToRender } from "./protocol";

export type {
  Composition,
  Plan,
  PlanAudioLayer,
  PlanLayer,
  PlanSegment,
  PlanVideoLayer,
  Ratio,
} from "./composition";
export { UnsupportedPlatformError } from "./platform";
export type { MediaInfo, PlatformFeature, Track } from "./protocol";

export interface EngineOptions {
  /**
   * The canvas the engine draws into. The engine takes control of it with
   * `transferControlToOffscreen`, so the app can no longer draw into it or get a context for it.
   */
  canvas: HTMLCanvasElement;
}

export interface Engine {
  /**
   * Opens the file behind `handle` in place of whatever is open: it stops playback, clears the
   * canvas to black and resolves with the file's format, duration and tracks. The handle comes from
   * `showOpenFilePicker` or a dropped item, or is one the app kept in IndexedDB; a kept handle
   * needs `handle.requestPermission` to grant reading it again first, or this rejects with the
   * `NotAllowedError` of `handle.getFile`. Rejects with an `Error` giving FFmpeg's reason if the
   * file cannot be opened, and with an `AbortError` if a later `open` or `compose` replaces it
   * before it resolves.
   */
  open(handle: FileSystemFileHandle): Promise<MediaInfo>;
  /**
   * Opens `composition` in place of whatever is open, as `open` does, and resolves once the files
   * its clips play from are open. The engine plays clips one after another, of any of its files:
   * each its video and audio in step, or either alone, placed anywhere in the composition, with
   * black and silence between and around them, and the clock running on to the composition's end.
   * It reads the plan once, from start to end. Rejects with a `NotSupportedError` naming what the
   * plan asks for beyond that, such as two clips at once, a transition, an effect or a speed; with
   * a `RangeError` if the duration is not a positive whole number of microseconds, or if a clip's
   * video or audio stream is not a video or audio track of its file; and for the reasons `open`
   * does.
   */
  compose(composition: Composition): Promise<void>;
  /**
   * Call after an edit to the open composition: reads its plan and duration again. If the
   * duration and the clips are unchanged, playback goes on untouched. Otherwise the composition
   * opens again and goes on from the time it was at (at most the new duration), playing if it
   * was, unless the app seeks or pauses while it opens. Rejects if no composition is open, and
   * for the reasons `compose` does.
   */
  changed(): Promise<void>;
  /**
   * Plays the open file's first video and first audio track, or the composition's clips, from
   * `currentTime`. It waits for the page to be visible and for the browser to allow audio (after
   * a user gesture), and resolves once audio is heard, or as soon as `pause` is called while it
   * waits. Rejects if nothing is open, the file has neither video nor audio, or playback has
   * failed, and with an `AbortError` if an `open` or `compose` stops it while it starts.
   */
  play(): Promise<void>;
  /**
   * Pauses, so that `play` goes on from here; `currentTime` holds still once it resolves.
   * Rejects if playback has failed.
   */
  pause(): Promise<void>;
  /**
   * Goes to `time`, in seconds; a time past the end goes to the end. Once it resolves, the frame
   * due at `time` is on screen, and if it was playing, audio goes on from there. A `play` still
   * starting starts from `time` instead. A seek that a later one replaces resolves. Paused in a
   * hidden page, it resolves once the page is shown. Rejects with a `RangeError` if `time` is
   * negative or not finite; if nothing is open or playback has failed; and with an `AbortError`
   * if an `open` or `compose` stops it.
   */
  seek(time: number): Promise<void>;
  /**
   * Goes to `time` for scrubbing while paused. As with `seek`, the frame due at `time` is on
   * screen once it resolves, but a call made while an earlier one is still under way only
   * changes where it goes next, so the screen follows a dragged playhead as fast as frames
   * decode, however often it is called. Going forward with no keyframe in between, it decodes on
   * from the frame on screen instead of starting from a keyframe, and shows the frames it passes.
   * Every call made during one scrub resolves once the frame due at the last target is on
   * screen; paused in a hidden page, once the page is shown. While playing, it is `seek`.
   * Rejects as `seek` does.
   */
  fastSeek(time: number): Promise<void>;
  /** The time being heard and seen now, in seconds, on the open file's or composition's clock. */
  readonly currentTime: number;
  /**
   * Stops playback, closes the audio context and terminates the engine's workers. Calling it
   * again does nothing.
   */
  close(): void;
}

// Playback starts only in a visible page: a hidden page gets no animation frames, so its video
// would not start with the audio.
const visible = () => document.visibilityState === "visible";

// A worker that fails to load fires a plain Event, without a message.
const loadError = (e: Event, worker: string) =>
  new Error(e instanceof ErrorEvent ? e.message : `the ${worker} worker failed to load`);

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

// Replies may come in any order, so each request carries an id.
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
    const call = Object.assign(Promise.withResolvers<FromMedia>(), { buffered });
    const id = next++;
    pending.set(id, call);
    // copy: a few fields per request, to add its id.
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
 * Starts an engine that draws into `canvas`. Rejects with an `UnsupportedPlatformError` naming
 * the first missing feature when the browser cannot run it, and with an `InvalidStateError` if
 * `canvas` already has a context or has been handed to another engine.
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

type Player = ReturnType<typeof createPlayerState>;

function createPlayerState(render: Worker, media: ReturnType<typeof createMedia>) {
  const waits = new Set<() => void>();

  // Called on every event that may change a condition an `until` is waiting on.
  function changed() {
    for (const wake of waits) wake();
  }

  return {
    render,
    media,
    waits,
    changed,
    // The file `open` opened; a composition's are in `streams.track`.
    opened: undefined as Opened | undefined,
    // What plays: the open file's streams, or the composition's clips. `duration` is the length
    // of what is open, in seconds.
    streams: { video: undefined, audio: undefined } as Played,
    composition: undefined as Composition | undefined,
    clips: [] as Clip[],
    duration: undefined as number | undefined,
    // Whether a file or a composition is open.
    ready: false,
    // Made on the first play and kept, as a page may create only a limited number of them.
    context: undefined as AudioContext | undefined,
    // Set at once, so a second play while the first starts joins it.
    playback: undefined as Promise<Playback> | undefined,
    started: undefined as Playback | undefined,
    // Why playing stopped, until the next open.
    failure: undefined as Error | undefined,
    // The id of the play under way, or -1: only its failures count. `next` is the next play's id.
    current: -1,
    next: 0,
    // Whether the last call was `play`, not `pause`, and nothing has stopped it since: an open, a
    // failure, or a play rejecting with no seek taking over. Only then does a seek or a scrub
    // play on. `pauses` counts pauses, so a play can tell that a pause stopped it.
    playing: false,
    pauses: 0,
    // Where the next play starts, in microseconds, or where a scrub has moved the paused play on
    // to; `moved` says which, as that play's audio is still where the scrub began. `seeks`
    // counts seeks.
    from: 0,
    moved: false,
    // Whether the current play has played: if so, its paused frame is where the clock stopped,
    // or a frame past it, not the frame due at `from`.
    played: false,
    seeks: 0,
    // How many opens there have been, so one that a later open replaces stops there.
    opens: 0,
    // The scrub under way (`running`) and the target it goes to next (`to`).
    scrub: { to: undefined as number | undefined, running: undefined as Promise<void> | undefined },
    // How far the render worker has decoded, as it last reported, and for which play.
    video: {
      id: -1,
      ahead: false,
      stuck: false,
      drawn: false,
      shown: false,
      reached: -1,
    } as VideoReport,
    closed: false,
  };
}

// Resolves once `done` returns true, which it checks now and on each change.
async function until(p: Player, done: () => boolean) {
  while (!done()) {
    const woken = Promise.withResolvers<void>();
    p.waits.add(woken.resolve);

    try {
      await woken.promise;
    } finally {
      p.waits.delete(woken.resolve);
    }
  }
}

function failPlayer(p: Player, error: Error) {
  p.failure ??= error;
  p.playing = false;
  p.from = 0;
  p.moved = false;
  p.played = false;
  stop(p);
}

function playbackHost(p: Player): PlaybackHost {
  return {
    render: p.render,
    demux: (message, buffered) => p.media.send(message, [], buffered),
    changed: p.changed,
    plays: (id) => p.current === id,
    video: () => p.video,
    fail: (error) => failPlayer(p, error),
  };
}

// Starts what is open playing into `context` as play `id`, from `p.from`.
async function startPlay(p: Player, context: AudioContext, id: number) {
  if (!p.ready) throw new Error("play: no file is open");
  const { opened, streams: played, from } = p;
  return startPlayback({ host: playbackHost(p), context, id, opened, played, from });
}

async function stopStarted(playback: Promise<Playback>) {
  try {
    const started = await playback;
    started.stop();
  } catch {
    // It never started; play already rejected with why.
  }
}

function stop(p: Player) {
  if (p.playback) void stopStarted(p.playback);
  p.playback = undefined;
  p.started = undefined;
  p.current = -1;
  p.changed();
}

// Stops what plays, clears the canvas and forgets what was open, for the open of `id`; throws
// an `AbortError` instead if a later open has replaced it.
function reset(p: Player, id: number) {
  if (id !== p.opens) throw new DOMException("open: replaced", "AbortError");
  stop(p);
  p.render.postMessage({ type: "clear" } satisfies ToRender);
  p.failure = undefined;
  p.playing = false;
  p.opened = undefined;
  p.streams = { video: undefined, audio: undefined };
  p.composition = undefined;
  p.clips = [];
  p.ready = false;
  p.from = 0;
  p.moved = false;
  p.played = false;
}

// Opens `file` in the media worker, as `asset` of a composition if given, for the open of `id`,
// and resolves with what it holds, once a later open has not replaced it: if one has, it must
// not set what is open, as that is the later open's to do.
async function load(p: Player, file: File, id: number, asset?: string): Promise<Opened> {
  const reply = await p.media.send({ type: "open", file, asset });
  if (reply.type !== "opened") throw new Error(`open: unexpected ${reply.type}`);
  if (id !== p.opens) throw new DOMException("open: replaced", "AbortError");
  return { info: reply.info, video: reply.video, index: reply.index };
}

async function open(p: Player, handle: FileSystemFileHandle) {
  const id = ++p.opens;
  const file = await handle.getFile();
  reset(p, id);
  const opened = await load(p, file, id);
  const video = opened.info.tracks.find((t) => t.kind === "video")?.id;
  const audio = opened.info.tracks.find((t) => t.kind === "audio")?.id;
  p.opened = opened;
  p.streams = { video, audio };
  p.duration = opened.info.duration;
  p.ready = true;
  return opened.info;
}

function checkStream(
  asset: Asset | undefined,
  stream: number | undefined,
  kind: "video" | "audio",
) {
  if (stream === undefined) return;
  const track = asset?.info.tracks.find((t) => t.id === stream);
  if (track?.kind !== kind) throw new RangeError(`compose: stream ${stream} is not ${kind}`);
}

// The files of the assets `clips` play from, each once, in the order they first play.
async function filesOf(composition: Composition, clips: Clip[]) {
  const files = new Map<string, File>();

  for (const { asset } of clips) {
    if (files.has(asset)) continue;
    const handle = await composition.source(asset);
    const file = await handle.getFile();
    files.set(asset, file);
  }

  return files;
}

// Opens each of `files` in turn, by asset, for the open of `id`, and checks `clips` against them.
async function loadAssets(p: Player, files: Map<string, File>, clips: Clip[], id: number) {
  const assets: Record<string, Asset> = {};

  for (const [asset, file] of files) {
    const opened = await load(p, file, id, asset);
    assets[asset] = Object.assign(opened, { file });
  }

  for (const { asset, video, audio } of clips) {
    checkStream(assets[asset], video, "video");
    checkStream(assets[asset], audio, "audio");
  }

  return assets;
}

async function compose(p: Player, composition: Composition) {
  const { duration } = composition;
  if (!Number.isSafeInteger(duration) || duration <= 0)
    throw new RangeError(`compose: a duration of ${duration} µs`);
  const clips = clipsOf(composition.plan(0, duration), duration);
  // Counted only once `clipsOf` accepts the plan, so a refused composition aborts no other open.
  const id = ++p.opens;
  const files = await filesOf(composition, clips);
  reset(p, id);
  const assets = await loadAssets(p, files, clips, id);
  const track = { clips, end: duration, assets };
  const played: Played = { video: undefined, audio: undefined, track };
  Object.assign(p, { streams: played, composition, clips });
  p.duration = duration / 1e6;
  p.ready = true;
}

// What clips play, as a string to compare: two lists that play the same give the same one.
const playedOf = (clips: Clip[]) =>
  JSON.stringify(clips.map((c) => [c.clip, c.asset, c.video, c.audio, c.in, c.out, c.offset]));

async function recompose(p: Player) {
  const { composition } = p;
  if (!composition) throw new Error("changed: no composition is open");
  const { duration } = composition;
  const kept = duration / 1e6 === p.duration;
  const clips = clipsOf(composition.plan(0, duration), duration);
  const unchanged = playedOf(clips) === playedOf(p.clips);
  if (kept && unchanged) return;
  const { playing, seeks, pauses } = p;
  const time = currentTime(p);
  await compose(p, composition);
  // A seek or a pause the app made meanwhile has the last word.
  if (p.seeks !== seeks || p.pauses !== pauses) return;
  await seek(p, Math.min(time, duration / 1e6));
  if (playing) await play(p);
}

// The play under way, or a new one from `p.from` if there is none, and its audio context.
async function begin(p: Player) {
  const context = (p.context ??= new AudioContext({ latencyHint: "playback" }));

  if (!p.playback) {
    p.current = p.next++;
    p.playback = startPlay(p, context, p.current);
  }

  const playback = p.playback;
  const started = await startedOrCleared(p, playback);
  // Unless an open stopped it while it started.
  if (p.playback === playback) p.started = started;
  return { context, started };
}

async function play(p: Player) {
  if (p.failure) throw p.failure;
  const pauses = p.pauses;
  p.playing = true;
  p.played = true;
  p.scrub.to = undefined;

  // A play a scrub has moved on has its audio where the scrub began, so start again from where
  // the scrub is.
  if (p.moved) {
    stop(p);
    p.moved = false;
    p.seeks++;
  }

  // A seek while it starts stops what it starts, and it goes on with the seek's.
  for (;;) {
    const seeks = p.seeks;

    try {
      await playOnce(p);
      return;
    } catch (e) {
      if (p.seeks === seeks || p.failure) {
        p.playing = false;
        throw e;
      }

      // A pause that came meanwhile wins; whatever else stopped it rejects this play too.
      if (!p.playing && p.pauses !== pauses) return;
      if (!p.playing) throw e;
    }
  }
}

async function playOnce(p: Player) {
  const { context, started } = await begin(p);
  const stopped = () => p.current !== started.id;

  // Rejects if an open or a failure stopped it while it waited.
  const check = () => {
    if (stopped()) throw p.failure ?? new DOMException("play: stopped", "AbortError");
  };

  await until(p, () => stopped() || !p.playing || (started.primed() && visible()));
  check();
  // Unless a pause came while it started.
  if (!p.playing) return;
  // Not awaited alone: without a user gesture it stays pending until one, and a pause or a
  // stop meanwhile settles this play.
  const resumed = resume(p, context);
  await until(p, () => stopped() || !p.playing || resumed.failed || started.heard());
  if (resumed.failed) throw resumed.error;
  check();
}

// Resumes `context`; whether it failed, and why, on the change that says so.
function resume(p: Player, context: AudioContext) {
  const resumed = { failed: false, error: undefined as unknown };

  async function run() {
    try {
      await context.resume();
    } catch (e) {
      resumed.failed = true;
      resumed.error = e;
      p.changed();
    }
  }

  void run();
  return resumed;
}

// `playback` once it has started; if it fails to, it is no longer what plays.
async function startedOrCleared(p: Player, playback: Promise<Playback>) {
  try {
    return await playback;
  } catch (e) {
    if (p.playback === playback) p.playback = undefined;
    throw e;
  }
}

async function pause(p: Player) {
  if (p.failure) throw p.failure;
  p.playing = false;
  p.pauses++;
  p.changed();
  await p.context?.suspend();
  // Published now, not on the next animation frame, so the clock holds once pause resolves,
  // in a hidden page too; at the time heard now, as far as the render worker has drawn.
  p.started?.publish(performance.now());
}

// `time` in seconds as a start in microseconds, at most the duration; or what is wrong.
function target(p: Player, time: number) {
  if (p.failure) throw p.failure;
  const duration = p.duration;
  if (!p.ready) throw new Error("seek: no file is open");
  if (!Number.isFinite(time) || time < 0) throw new RangeError(`seek: ${time} s`);
  return Math.min(Math.round(Math.min(time, duration ?? time) * 1e6), Number.MAX_SAFE_INTEGER);
}

async function seek(p: Player, time: number) {
  const to = target(p, time);
  p.scrub.to = undefined;
  return go(p, to);
}

async function fastSeek(p: Player, time: number) {
  const to = target(p, time);
  if (p.playing) return seek(p, time);
  p.scrub.to = to;
  p.scrub.running ??= scrub(p);
  return p.scrub.running;
}

// Goes to each target a scrub is given in turn, the last one each time, until none is left.
async function scrub(p: Player) {
  try {
    for (let to = p.scrub.to; to !== undefined; to = p.scrub.to) {
      p.scrub.to = undefined;
      await (movable(p, to) ? move(p, to) : go(p, to));
    }
  } finally {
    p.scrub.running = undefined;
  }
}

const within = (c: Clip, time: number) => time >= startOf(c) && time < endOf(c);

// Whether the paused play can reach `to` by decoding on: it has not played, so the frame up is
// the one due at `from`; `to` is ahead of it, in the same clip of a composition; and the index
// has no keyframe after `from` up to `to`, as starting again would decode from that keyframe,
// with fewer frames to go.
function movable(p: Player, to: number) {
  const { started } = p;
  if (p.played || !started?.drawn() || p.video.id !== started.id) return false;
  const clip = p.clips.find((c) => within(c, p.from));
  if (p.composition && !(clip && within(clip, to))) return false;
  // In the file's time, where the index is.
  const offset = clip?.offset ?? 0;
  const [from, there] = [p.from - offset, to - offset];
  const stream = clip ? clip.video : p.streams.video;
  const opened = clip ? p.streams.track?.assets[clip.asset] : p.opened;
  const index = stream === undefined ? undefined : opened?.index[stream];
  const { keyframes, end } = index ?? { keyframes: [], end: -Infinity };
  if (there < from || there > end) return false;
  return !keyframes.some((k) => k > from && k <= there);
}

// Moves the paused play on to `to` (microseconds); resolves once its frame is up.
async function move(p: Player, to: number) {
  const id = p.current;
  const seeks = p.seeks;
  // Its audio is never heard, as a play starts again from the scrub: stopped, it no longer
  // fills, so the media worker demuxes on for the video however far the scrub goes.
  if (!p.moved) p.started?.clock.close();
  p.from = to;
  p.moved = true;
  p.render.postMessage({ type: "scrub", id, to } satisfies ToRender);
  await until(p, () => p.current !== id || (p.video.id === id && p.video.reached === to));
  // Stopped: by a seek or a play, which take over, or else by an open or a failure.
  if (p.current === id || (p.seeks !== seeks && !p.failure)) return;
  throw p.failure ?? new DOMException("seek: stopped", "AbortError");
}

// Starts playing again from `from` (microseconds); paused, resolves once the frame due then is
// drawn.
async function go(p: Player, from: number) {
  stop(p);
  p.from = from;
  p.moved = false;
  p.played = false;
  const seeks = ++p.seeks;

  // Paused while it starts, it goes on as a paused seek: its frame up before it resolves.
  if (p.playing) {
    await play(p);
    if (p.playing) return;
  }

  try {
    const { started } = await begin(p);
    await until(p, () => p.current !== started.id || started.drawn());
    if (p.current === started.id) return;
  } catch (e) {
    if (p.seeks === seeks) throw e;
  }

  // Stopped: by a later seek, which takes over, or else by an open or a failure.
  if (p.seeks === seeks || p.failure) {
    throw p.failure ?? new DOMException("seek: stopped", "AbortError");
  }
}

// The time heard now, in seconds: the file's, or the composition's.
function currentTime(p: Player) {
  const now = performance.timeOrigin + performance.now();
  if (p.moved || !p.started) return p.from / 1e6;
  return p.started.clock.heard(now);
}

function closePlayer(p: Player) {
  if (p.closed) return;
  p.closed = true;
  document.removeEventListener("visibilitychange", p.changed);
  stop(p);
  void p.context?.close();
  p.render.terminate();
  p.media.close();
}

// The engine on a render worker that is ready and a media worker.
function createPlayer(render: Worker, media: ReturnType<typeof createMedia>): Engine {
  const p = createPlayerState(render, media);
  document.addEventListener("visibilitychange", p.changed);

  render.addEventListener("message", ({ data }: MessageEvent<FromRender>) => {
    if (data.type === "video") p.video = data;
    if (data.type === "error" && data.id === p.current) failPlayer(p, new Error(data.message));
    p.changed();
  });
  // An uncaught error in the render worker.
  render.addEventListener("error", (e) => failPlayer(p, loadError(e, "render")));

  return {
    open: (handle) => open(p, handle),
    play: () => play(p),
    pause: () => pause(p),
    seek: (time) => seek(p, time),
    fastSeek: (time) => fastSeek(p, time),
    compose: (composition) => compose(p, composition),
    changed: () => recompose(p),
    get currentTime() {
      return currentTime(p);
    },
    close: () => closePlayer(p),
  };
}

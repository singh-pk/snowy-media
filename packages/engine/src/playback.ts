// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// One play on the main thread (docs/architecture.md#playback): its rings and audio output, the
// output timestamp it publishes for the render worker's clock, and whether it may start and is
// heard.

import { createAudioOutput } from "./audio";
import type { VideoParams } from "./codec";
import { type Clip, endOf } from "./composition";
import { createPcmControl, createPcmProducer, createPcmRing } from "./pcm";
import type { FromMedia, FromRender, Opened, ToMedia, ToRender, VideoClip } from "./protocol";
import { closeRing, createRing, RING_CAPACITY } from "./ring";

// The PCM ring's length at `rate`: the smallest power of two that holds a second, so the media
// worker can demux a second of video ahead of the audio it decodes.
const pcmFrames = (rate: number) => 2 ** Math.ceil(Math.log2(rate));
// The packet ring of a play without video, which only ever carries the END record.
const NO_VIDEO_RING = 64;
// The audio buffered before a play starts, in seconds, so a slow start does not underrun.
const PREROLL = 0.25;
// The output timestamp has settled once this many newer ones in a row agree within SETTLED_MS:
// Chromium moves the first ones after output starts by up to 35 ms. Coarse timers may never
// agree, so it settles anyway after SETTLED_LIMIT newer ones.
const SETTLED_COUNT = 2;
const SETTLED_MS = 2;
const SETTLED_LIMIT = 10;
// What the PCM ring mixes to; the context's destination takes stereo everywhere.
const CHANNELS = 2;

type Clock = ReturnType<typeof createPcmControl>;
type Output = ReturnType<typeof createOutputClock>["output"];
type DemuxMessage = Omit<Extract<ToMedia, { type: "demux" }>, "id">;
type ReadMessage = DemuxMessage | Omit<Extract<ToMedia, { type: "track" }>, "id">;

/** How far the render worker has decoded, as it last reported, and for which play. */
export type VideoReport = Omit<Extract<FromRender, { type: "video" }>, "type">;

export interface Playback {
  id: number;
  clock: Clock;
  publish(stopping?: number): void;
  primed(): boolean;
  drawn(): boolean;
  heard(): boolean;
  stop(): void;
}

export interface PlaybackHost {
  render: Worker;
  /** Sends the media worker a read request; `buffered` runs once its audio is buffered. */
  demux: (message: ReadMessage, buffered: () => void) => Promise<FromMedia>;
  /** Has whatever waits on the engine's state look again. */
  changed: () => void;
  /** Whether play `id` is what plays, so its failures count. */
  plays: (id: number) => boolean;
  video: () => VideoReport;
  fail: (error: Error) => void;
}

export interface PlaybackOptions {
  host: PlaybackHost;
  context: AudioContext;
  id: number;
  /** The open file's video parameters, by stream; none for a composition. */
  opened: { video: Record<number, VideoParams> } | undefined;
  played: Played;
  /** The media time the play starts at, in microseconds. */
  from: number;
}

/** A composition's asset, opened: its file, and what the media worker found in it. */
export interface Asset extends Opened {
  file: File;
}

/**
 * What a play plays: the open file's streams, or a composition's clips (src/composition.ts) in
 * the order they play, on a composition that ends at `end`, in microseconds, from `assets`.
 */
export interface Played {
  video: number | undefined;
  audio: number | undefined;
  track?: { clips: Clip[]; end: number; assets: Record<string, Asset> } | undefined;
}

interface Reading {
  host: PlaybackHost;
  id: number;
  ring: SharedArrayBuffer;
  pcm: SharedArrayBuffer;
  from: number;
  params: VideoParams | undefined;
  audio: number | undefined;
  played: Played;
  // A composition's clips the play reaches.
  clips: Clip[];
  preroll: number;
}

// The clips a play from `from` reaches, the first cut to start there.
function clipsFrom(clips: Clip[], from: number) {
  const reached = clips.filter((c) => endOf(c) > from);
  const [first] = reached;
  // copy: the clip the play starts in, once a play, so the plan's own is left as it is.
  if (first) reached[0] = { ...first, in: Math.max(first.in, from - first.offset) };
  return reached;
}

// The clips of `clips` with video, as the render worker plays them.
const videoOf = (clips: Clip[], assets: Record<string, Asset>) =>
  clips.flatMap(({ asset, video: stream, ...place }): VideoClip[] => {
    const params = stream === undefined ? undefined : assets[asset]?.video[stream];
    return params ? [{ params, in: place.in, out: place.out, offset: place.offset }] : [];
  });

// Resolves once the media worker has read what the play plays, or at once with nothing to read,
// as after the last clip, where the clock runs on in silence to the composition's `end`.
function startTrack(r: Reading, track: NonNullable<Played["track"]>, buffered: () => void) {
  const { host, id, ring, pcm, from, clips } = r;
  const { end, assets } = track;
  const shown = videoOf(clips, assets);
  if (shown.length > 0)
    host.render.postMessage({ type: "play", id, ring, pcm, from, clips: shown });
  else host.render.postMessage({ type: "clear" } satisfies ToRender);

  if (clips.length === 0) {
    const producer = createPcmProducer(pcm);
    producer.finish();
    producer.reach(end / 1e6);
    buffered();
    return Promise.resolve();
  }

  const files: Record<string, File> = {};

  for (const { asset } of clips) {
    const file = assets[asset]?.file;
    if (file) files[asset] = file;
  }

  const { preroll } = r;
  return host.demux({ type: "track", ring, pcm, from, clips, files, end, preroll }, buffered);
}

// A file's video and audio, read from `from`; its video plays as one clip to its end.
function startReading(r: Reading, buffered: () => void): Promise<unknown> {
  const { host, id, ring, pcm, from, params, audio, played } = r;

  if (params) {
    const clips = [{ params, in: from, out: Infinity, offset: 0 }];
    host.render.postMessage({ type: "play", id, ring, pcm, from, clips });
  }

  const streams = params && played.video !== undefined ? [played.video] : [];
  const message: DemuxMessage = { type: "demux", ring, streams, from, pcm };
  if (audio !== undefined) message.audio = { stream: audio, preroll: r.preroll };
  return host.demux(message, buffered);
}

// Publishes the output timestamp for the render worker (src/pcm.ts) on every animation frame,
// running once it has settled. A pause at `stopping` (milliseconds of `performance.now()`) holds
// the media time heard then until the clock passes it, so the clock never goes back, though the
// last timestamp is up to an audio callback old and carried forward.
function createOutputClock(context: AudioContext, clock: Clock, changed: () => void) {
  // `offset` is the last output timestamp's context time minus its performance time, in
  // milliseconds, and `at` its performance time; `stopped` is the media time a pause holds.
  const output = { offset: Number.NaN, at: 0, agreed: 0, newer: 0, settled: false, stopped: NaN };

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

    // The time heard at the pause is no further than the worklet has rendered; a second pause
    // while one is held keeps the later time, so the clock never goes back.
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

  return { output, publish };
}

interface ReadinessOptions {
  host: PlaybackHost;
  id: number;
  hasVideo: boolean;
  demux: { buffered: boolean; done: boolean };
  output: Output;
}

function createReadiness({ host, id, hasVideo, demux, output }: ReadinessOptions) {
  const prerolled = { done: false };

  // Whether it may start, once and for good: video is decoded and audio buffered ahead, or
  // the render worker says video can get no further while the context is held, as for
  // sparse video or a short audio track. A full PCM ring is audio ahead.
  function primed() {
    const video = host.video();
    const reported = video.id === id ? video : undefined;
    const videoAhead = !hasVideo || reported?.ahead === true;
    const audioAhead = demux.buffered || demux.done;
    prerolled.done ||= (videoAhead && audioAhead) || reported?.stuck === true;
    return prerolled.done;
  }

  // Whether the frame due at the start is on screen; without video, once it may start.
  function drawn() {
    const video = host.video();
    return hasVideo ? video.id === id && video.drawn : primed();
  }

  // Whether the play is heard: the output timestamp has settled and no pause holds it, and the
  // frame on screen was shown by that clock.
  function heard() {
    const video = host.video();
    const shown = !hasVideo || (video.id === id && video.shown);
    return output.settled && Number.isNaN(output.stopped) && shown;
  }

  return { primed, drawn, heard };
}

export async function startPlayback(options: PlaybackOptions): Promise<Playback> {
  const { host, context, id, opened, played, from } = options;
  const { track } = played;
  const video = opened?.video ?? {};
  const audio = track ? undefined : played.audio;
  const params = !track && played.video !== undefined ? video[played.video] : undefined;

  if (!track && audio === undefined && !params)
    throw new Error("play: the file has no video or audio to play");

  const clips = track ? clipsFrom(track.clips, from) : [];
  const hasVideo = Boolean(params) || clips.some((c) => c.video !== undefined);

  const frames = pcmFrames(context.sampleRate);
  const pcm = createPcmRing(frames, CHANNELS, context.sampleRate, from / 1e6);
  const clock = createPcmControl(pcm);
  // Held while it prerolls: a context made in a user gesture starts running by itself, and
  // one that played the last file still runs.
  await context.suspend();
  const node = await createAudioOutput(context, pcm);

  // An open may have stopped this play while the worklet loaded, and the media worker may
  // hold another file already.
  if (!host.plays(id)) {
    clock.close();
    node.disconnect();
    throw new DOMException("play: stopped while it started", "AbortError");
  }

  const ring = createRing(hasVideo ? RING_CAPACITY : NO_VIDEO_RING);
  const demux = { buffered: false, done: false };
  const preroll = PREROLL * context.sampleRate;
  const reading = { host, id, ring, pcm, from, params, audio, played, clips, preroll };

  const buffered = () => {
    demux.buffered = true;
    host.changed();
  };

  const demuxed = track ? startTrack(reading, track, buffered) : startReading(reading, buffered);

  const frame = { id: 0 };
  const { output, publish } = createOutputClock(context, clock, host.changed);
  const { primed, drawn, heard } = createReadiness({
    host,
    id,
    hasVideo,
    demux,
    output,
  });

  function everyFrame() {
    publish();
    frame.id = requestAnimationFrame(everyFrame);
  }

  async function watch() {
    try {
      await demuxed;
      demux.done = true;
      host.changed();
    } catch (e) {
      if (host.plays(id)) host.fail(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // Stops both rings' producer, so the media worker is free for the next request.
  function stop() {
    cancelAnimationFrame(frame.id);
    host.render.postMessage({ type: "stop" } satisfies ToRender);
    clock.close();
    closeRing(ring);
    node.disconnect();
  }

  everyFrame();
  void watch();
  return { id, clock, publish, primed, drawn, heard, stop };
}

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// One play on the main thread: its rings and audio output, the output timestamp it publishes
// for the render worker's clock, and whether it may start and is heard.

import { createAudioOutput } from "./audio";
import type { VideoParams } from "./codec";
import { createPcmControl, createPcmRing } from "./pcm";
import type { FromMedia, FromRender, MediaInfo, ToMedia, ToRender } from "./protocol";
import { closeRing, createRing, RING_CAPACITY } from "./ring";

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

type Clock = ReturnType<typeof createPcmControl>;
type Output = ReturnType<typeof createOutputClock>["output"];
type DemuxMessage = Omit<Extract<ToMedia, { type: "demux" }>, "id">;

/** How far the render worker has decoded, as it last reported, and for which play. */
export type VideoReport = Omit<Extract<FromRender, { type: "video" }>, "type">;

// What plays: play `id`, its clock, publishing the output timestamp now, whether it may
// start and is heard, and stopping it.
export interface Playback {
  id: number;
  clock: Clock;
  publish(stopping?: number): void;
  primed(): boolean;
  drawn(): boolean;
  heard(): boolean;
  stop(): void;
}

/** What a play needs of the engine that starts it. */
export interface PlaybackHost {
  render: Worker;
  /** Sends the media worker a demux request; `buffered` runs once its audio is buffered. */
  demux: (message: DemuxMessage, buffered: () => void) => Promise<FromMedia>;
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
  opened: { info: MediaInfo; video: Record<number, VideoParams> };
  /** Where it starts, in microseconds. */
  from: number;
}

// The output timestamp, for the render worker (src/pcm.ts), on every animation frame and
// as the context stops. It runs once it has settled, and stays so until the context stops.
// Stopped by a pause at `stopping` (performance milliseconds), it holds the media time heard
// then until a timestamp passes it, so the clock never goes back: the last timestamp
// is up to an audio callback older, and the frame on screen went up by it carried forward.
function createOutputClock(context: AudioContext, clock: Clock, changed: () => void) {
  // The last output timestamp, as context minus performance milliseconds, and when; and the
  // media time heard when a pause stopped it, until a timestamp passes it.
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

  // Whether it is heard, by a settled timestamp past a pause's, and the frame on screen went
  // up by it.
  function heard() {
    const video = host.video();
    const shown = !hasVideo || (video.id === id && video.shown);
    return output.settled && Number.isNaN(output.stopped) && shown;
  }

  return { primed, drawn, heard };
}

/** Starts the open file playing into `context` from `from`, as play `id`. */
export async function startPlayback(options: PlaybackOptions): Promise<Playback> {
  const { host, context, id, opened, from } = options;
  const audio = opened.info.tracks.find((t) => t.kind === "audio");
  // The clock is the audio's, so a file without audio has none.
  if (!audio) throw new Error("play: a file without audio does not play yet");
  const video = opened.info.tracks.find((t) => t.kind === "video");
  const params = video && opened.video[video.id];
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

  const ring = createRing(params ? RING_CAPACITY : NO_VIDEO_RING);
  if (params)
    host.render.postMessage({ type: "play", id, ring, params, pcm, from } satisfies ToRender);
  const streams = video && params ? [video.id] : [];
  const request = { stream: audio.id, pcm, preroll: PREROLL * context.sampleRate };
  const demux = { buffered: false, done: false };

  const demuxed = host.demux({ type: "demux", ring, streams, from, audio: request }, () => {
    demux.buffered = true;
    host.changed();
  });

  const frame = { id: 0 };
  const { output, publish } = createOutputClock(context, clock, host.changed);
  const { primed, drawn, heard } = createReadiness({
    host,
    id,
    hasVideo: Boolean(params),
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

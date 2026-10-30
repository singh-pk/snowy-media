// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The page code that plays the media worker's audio through the engine's AudioWorklet into an
// OfflineAudioContext, for test/audio.test.ts.

import { createAudioOutput } from "../../src/audio";
import { clipsFrom } from "../../src/composition";
import { createPcmControl, createPcmRing } from "../../src/pcm";
import { createRing } from "../../src/ring";
import { PCM_CHANNELS, PCM_RATE, probe, SAMPLE_FRAMES } from "./audio";
import type { startMedia } from "./page";

interface Placed {
  in: number;
  out: number;
  offset: number;
}

interface Track {
  from: number;
  clips: Placed[];
  end: number;
  layers?: Placed[][];
  files?: Record<string, File>;
  opens?: number;
}

/**
 * Plays audio stream `stream` of the file open in `media` through the engine's worklet (at
 * `worklet`) into an OfflineAudioContext of `seconds`, resampled to `channels` channels. The
 * ring holds `frames` frames, room for all of the audio, which is decoded before rendering
 * starts, so it underruns only at the end. Returns the media time of the first frame; the
 * clock's media time less its context time, every SAMPLE_FRAMES frames while it runs; the
 * clock at the end; when channel 0 clicks, in context time; and, in stereo, the probe of what
 * played (test/support/audio.ts). A track (src/protocol.ts) plays the stream's `clips`, in
 * microseconds of the file, `offset` later on a clock that starts at `from` and runs on to `end`,
 * cut to start there as a play cuts them; each of its `layers` is more clips of it, read by the media worker of `readers` at its index
 * into a ring of its own, which the worklet mixes in. Its `files` and `opens`, if given, go with
 * each read.
 */
export async function play(
  media: ReturnType<typeof startMedia>,
  stream: number,
  {
    worklet,
    seconds,
    channels,
    frames,
    track,
    readers = [],
  }: Record<"seconds" | "channels" | "frames", number> & {
    worklet: string;
    track?: Track | undefined;
    readers?: ReturnType<typeof startMedia>[];
  },
) {
  const start = (track?.from ?? 0) / 1e6;
  const ringOf = () => createPcmRing(2 ** Math.ceil(Math.log2(frames)), channels, PCM_RATE, start);
  const pcm = ringOf();
  const layers = (track?.layers ?? []).map(ringOf);
  const control = createPcmControl(pcm);
  const length = seconds * PCM_RATE;
  const context = new OfflineAudioContext({
    numberOfChannels: channels,
    length,
    sampleRate: PCM_RATE,
  });
  await createAudioOutput(context, pcm, { worklet, layers });
  // No packets: the ring only gets the END record.
  const ring = createRing(64);
  const audio = { stream, preroll: 0 };
  const clip = { clip: "", asset: "", video: undefined, audio: stream };
  const from = track?.from ?? 0;
  const ofStream = (placed: Placed[]) =>
    clipsFrom(
      placed.map((c) => ({ ...c, ...clip })),
      from,
    );
  const read = track && {
    type: "track" as const,
    from,
    end: track.end,
    files: track.files ?? {},
    opens: track.opens ?? 0,
    preroll: 0,
  };
  const demux = { type: "demux" as const, ring, streams: [], from: 0, pcm, audio };
  await media.request(read ? { ...read, ring, pcm, clips: ofStream(track.clips) } : demux);

  for (const [k, each] of (track?.layers ?? []).entries()) {
    const [reader, into] = [readers[k], layers[k]];
    if (!read || !reader || !into) throw new Error(`no reader for layer ${k}`);
    await reader.request({ ...read, ring: createRing(64), pcm: into, clips: ofStream(each) });
  }

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

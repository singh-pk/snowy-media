// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The page code that drives the render worker's video track (src/track.ts) directly, on the
// page's animation frames as the render worker does on its own, for test/render.test.ts.

import { createCompositor } from "../../src/compositor";
import { createPcmRing } from "../../src/pcm";
import type { VideoParams } from "../../src/codec";
import { createRing, RING_CAPACITY } from "../../src/ring";
import { createTrack } from "../../src/track";
import { PCM_CHANNELS, PCM_RATE } from "./audio";
import { readFrameId } from "./frame-id";
import { createReadBack, readableCanvas, type startMedia, wasm } from "./page";

// How many animation frames a time may take to go up before the test gives up on it.
const MAX_FRAMES = 600;

interface TrackPlay {
  clips: { in: number; out: number; offset: number }[];
  times: number[];
  width: number;
  height: number;
}

const animationFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/**
 * Reads `clips` (microseconds of the file, each shown `offset` later) of video stream `stream`
 * of the file open in `media` as a track, and shows each of `times` in turn into a `width` ×
 * `height` canvas from the moment the track starts, so the first passes the clips before it
 * before their outputs have read them. Returns the frame number on the canvas once the frame due
 * at each time is up; and, for each time after the first, whether the track decoded up to it
 * while the time before it was shown, as it must to show it when due.
 */
export async function renderTrack(
  media: ReturnType<typeof startMedia>,
  stream: number,
  p: VideoParams,
  { clips, times, width, height }: TrackPlay,
) {
  const { device, context, format } = await readableCanvas(width, height);
  const readBack = createReadBack(device, width, height);
  const ring = createRing(RING_CAPACITY);
  const end = Math.max(...clips.map((c) => c.out + c.offset));
  // Room for the silence of the whole track, which nothing plays.
  const room = 2 ** Math.ceil(Math.log2((end / 1e6) * PCM_RATE));
  const pcm = createPcmRing(room, PCM_CHANNELS, PCM_RATE);
  const placed = clips.map((c) => ({ ...c, clip: "", asset: "", video: stream, audio: undefined }));
  const request = { type: "track" as const, ring, pcm, from: 0, clips: placed, end, preroll: 0 };
  const demuxed = media.request(request);
  const compositor = createCompositor(device, context, format);
  const options = { compositor, wasm, changed: () => {}, freed: () => {} };
  const track = createTrack(
    ring,
    clips.map(({ in: from, out, offset }) => ({ params: p, in: from, out, offset })),
    options,
  );
  // The frame on the canvas, read in the task that drew it, before its texture expires.
  const onCanvas = { id: -1 };
  const shown: number[] = [];
  const ahead: boolean[] = [];

  async function frameOnCanvas() {
    const pixels = await readBack(context);
    return readFrameId(pixels.subarray(1), width * 4, 4);
  }

  async function decodedBy(time: number, before: number) {
    for (let frames = 0; frames < MAX_FRAMES; frames++) {
      if (track.decodedTo() >= time) return true;
      if (track.present(before)) onCanvas.id = await frameOnCanvas();
      await animationFrame();
    }

    return false;
  }

  // Passes the clips before the first time while their outputs have read nothing yet.
  track.present(times[0] ?? 0);

  try {
    for (const [i, time] of times.entries()) {
      const before = times[i - 1];

      if (before !== undefined) {
        const decoded = await decodedBy(time, before);
        ahead.push(decoded);
      }

      for (let frames = 0; frames < MAX_FRAMES; frames++) {
        if (track.present(time)) onCanvas.id = await frameOnCanvas();
        if (track.reached(time)) break;
        await animationFrame();
      }

      shown.push(onCanvas.id);
    }
  } finally {
    track.close();
    await demuxed;
    device.destroy();
  }

  return { shown, ahead };
}

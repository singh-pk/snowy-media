// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The video output (src/video.ts) in Chromium: for every fixture, frames decoded from the packet ring go up on the canvas at their own
// timestamps, stay up until the next one is due, and are skipped when the time jumps past
// them; and the first frame, drawn through the compositor at the size it is shown at (over its
// scale, for a fixture whose frame numbers are scaled up), has the layout of native FFmpeg's,
// display matrix included (test/fixtures/expected.json). A WebCodecs frame drawn straight from the
// GPU, where its measured route goes so, looks as the same frame drawn from its planes.
// Usage: bun run test.

import { afterAll, expect, test } from "bun:test";
import { decodable, launch } from "./support/browsers";
import { MEDIA_WORKER, PAGE, serveEngine } from "./support/serve";
import type * as PageSupport from "./support/page";

interface Video {
  id: number;
  codec: string;
  timeBase: string;
  width: number;
  height: number;
  pts: number[];
  shown: [number, number];
  grid: number[];
  // Set for a codec WebCodecs decodes, which video.test.ts checks.
  codecString?: string;
  scale?: number;
}

const generated = await Bun.file(new URL("fixtures/expected.json", import.meta.url)).json();
const expected: Record<string, { video: Video }> = decodable(generated);
// Frames shown one by one, then a jump to a later one.
const STEPS = 20;
const JUMP = 59;
// How closely a frame's brightness grid follows FFmpeg's (a correlation). A frame turned or
// mirrored the wrong way falls far below.
const MIN_CORRELATION = 0.9;
// How far its cells may be from FFmpeg's on average, in 8-bit levels: the compositor converts
// Y′CbCr as FFmpeg does, which leaves rounding, scaling to the canvas, and Chromium's own
// conversion of a frame whose planes cannot be read (a 10-bit frame from the GPU decoder).
const MAX_LEVEL_DIFFERENCE = 2;
// How far a frame drawn straight from the GPU may be from the same frame drawn from its planes,
// in 8-bit levels, at the median and the 95th percentile of its channels: as far as the
// measurement lets a route import (src/compositor.ts), plus rounding.
const MAX_IMPORTED_OFF = [2, 7];
const server = await serveEngine("<!doctype html><title>test</title>");

afterAll(() => server.stop(true));

const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;

// Pearson's correlation of `a` and `b`.
function correlation(a: number[], b: number[]) {
  const [ma, mb] = [mean(a), mean(b)];
  let [ab, aa, bb] = [0, 0, 0];

  for (const [i, x] of a.entries()) {
    const y = b[i] ?? 0;
    ab += (x - ma) * (y - mb);
    aa += (x - ma) ** 2;
    bb += (y - mb) ** 2;
  }

  return ab / Math.sqrt(aa * bb);
}

// The frames shown, in order, and each frame's time in microseconds as the engine rounds it.
function plan(video: Video) {
  const [num = 1, den = 1] = video.timeBase.split("/").map(Number);
  const micros = (pts: number) => Math.round((pts * num * 1e6) / den);
  const frames = [...Array(Math.min(STEPS, video.pts.length)).keys()];
  if (video.pts.length > JUMP) frames.push(JUMP);
  const times: number[] = [];
  const drawn: boolean[] = [];

  for (const [k, frame] of frames.entries()) {
    const time = micros(video.pts[frame] ?? 0);
    times.push(time);
    drawn.push(true);
    const next = video.pts[frame + 1];

    // Halfway to the next frame, the same frame stays up.
    if (k + 1 < frames.length && next !== undefined) {
      times.push(Math.floor((time + micros(next)) / 2));
      drawn.push(false);
    }
  }

  return { frames, times, drawn };
}

test("a decoder the video decode worker fails reports why, closes cleanly, and the next decodes", async () => {
  const browser = await launch();
  const name = "mpeg2-aac.mov";

  try {
    const tab = await browser.newPage();
    // An uncaught error, a promise rejected with no handler among them.
    const errors: string[] = [];
    tab.on("pageerror", (e) => errors.push(e.message));
    await tab.goto(server.url.href);
    const got = await tab.evaluate(
      async ({ page, worker, n }) => {
        const support: typeof PageSupport = await import(page);
        const media = support.startMedia(worker);
        const res = await fetch(`/test/fixtures/${n}`);
        const blob = await res.blob();
        const opened = await media.request({ type: "open", file: new File([blob], n) });
        if (opened.type !== "opened") throw new Error(`${n}: ${opened.type}`);
        const params = opened.video[0];
        if (!params) throw new Error(`${n}: no video parameters`);
        const message = await support.failInWorker(params);
        const size = { times: [0], width: params.width, height: params.height };
        const { shown } = await support.render(media, 0, params, size);
        media.stop();
        return { message, shown };
      },
      { page: PAGE, worker: MEDIA_WORKER, n: name },
    );
    expect(got.message).toContain("decoder_open_params");
    expect(got.shown).toEqual([{ drawn: true, id: 0 }]);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 60_000);

test("a demux that fails stops decoding, leaving the media worker's error the only report", async () => {
  const browser = await launch();
  const name = "h264-aac.mp4";

  try {
    const tab = await browser.newPage();
    await tab.goto(server.url.href);
    const got = await tab.evaluate(
      async ({ page, worker, n }) => {
        const support: typeof PageSupport = await import(page);
        const media = support.startMedia(worker);
        const res = await fetch(`/test/fixtures/${n}`);
        const blob = await res.blob();
        const opened = await media.request({ type: "open", file: new File([blob], n) });
        if (opened.type !== "opened") throw new Error(`${n}: ${opened.type}`);
        const params = opened.video[0];
        if (!params) throw new Error(`${n}: no video parameters`);
        const result = await support.failDemux(media, 0, params);
        media.stop();
        return result;
      },
      { page: PAGE, worker: MEDIA_WORKER, n: name },
    );
    expect(got).toEqual({ message: "Error: demux: from -1", done: false });
  } finally {
    await browser.close();
  }
}, 60_000);

test("a frame put up for a time goes up even if the time stops short of it", async () => {
  const browser = await launch();
  const file = "h264-aac.mp4";
  const video = expected[file]?.video;
  if (!video) throw new Error(`no video in ${file}`);
  const [num = 1, den = 1] = video.timeBase.split("/").map(Number);
  const micros = (frame: number) => Math.round(((video.pts[frame] ?? 0) * num * 1e6) / den);
  // Frame 5 is taken as due, its upload coming after; then the time stops between frames 4
  // and 5, as a pause stops the clock short of the refresh a frame was put up for.
  const times = [micros(5), Math.floor((micros(4) + micros(5)) / 2)];

  try {
    const tab = await browser.newPage();
    await tab.goto(server.url.href);
    const got = await tab.evaluate(
      async ({ page, worker, n, stream, size }) => {
        const support: typeof PageSupport = await import(page);
        const media = support.startMedia(worker);
        const res = await fetch(`/test/fixtures/${n}`);
        const blob = await res.blob();
        const opened = await media.request({ type: "open", file: new File([blob], n) });
        if (opened.type !== "opened") throw new Error(`${n}: ${opened.type}`);
        const params = opened.video[stream];
        if (!params) throw new Error(`${n}: no parameters for stream ${stream}`);
        const result = await support.render(media, stream, params, size);
        media.stop();
        return result.shown;
      },
      {
        page: PAGE,
        worker: MEDIA_WORKER,
        n: file,
        stream: video.id,
        size: { times, width: video.width, height: video.height, ahead: true },
      },
    );

    // The setup holds: 5 was not up by the first time, only taken, with 3 and 4 closed.
    expect(got[0]?.id).toBeLessThan(4);
    // Frames 3 and 4 were closed when 5 was taken: 5 goes up, not an older frame left on screen.
    expect(got.at(-1)).toEqual({ drawn: true, id: 5 });
  } finally {
    await browser.close();
  }
}, 60_000);

test("a decoder closed partway through handing over a packet leaves the next decoder whole frames", async () => {
  const browser = await launch();
  const name = "mpeg2-aac.mov";
  const { video } = expected[name] ?? { video: undefined };
  if (!video) throw new Error(`${name}: no expected results`);
  const { frames, times } = plan(video);

  try {
    const tab = await browser.newPage();
    await tab.goto(server.url.href);
    const got = await tab.evaluate(
      async ({ page, worker, n, size }) => {
        const support: typeof PageSupport = await import(page);
        const media = support.startMedia(worker);
        const res = await fetch(`/test/fixtures/${n}`);
        const blob = await res.blob();
        const opened = await media.request({ type: "open", file: new File([blob], n) });
        if (opened.type !== "opened") throw new Error(`${n}: ${opened.type}`);
        const params = opened.video[0];
        if (!params) throw new Error(`${n}: no video parameters`);
        const capacity = 1 << 16;
        const decoders = support.startDecoders(capacity);
        const partial = support.abandonPacket(decoders, params, capacity);
        const rings = { packets: 1 << 12, decoders };
        const { shown } = await support.render(media, 0, params, size, rings);
        media.stop();
        return { partial, ids: shown.filter((s) => s.drawn).map((s) => s.id) };
      },
      {
        page: PAGE,
        worker: MEDIA_WORKER,
        n: name,
        size: { times, width: video.width, height: video.height },
      },
    );
    expect(got).toEqual({ partial: true, ids: frames });
  } finally {
    await browser.close();
  }
}, 60_000);

for (const [file, { video }] of Object.entries(expected)) {
  test(`shows ${file} at its timestamps, as FFmpeg shows it`, async () => {
    const browser = await launch();
    const { frames, times, drawn } = plan(video);
    // At the size it is shown at, as the grid is, over the size of its frame numbers.
    const scale = video.scale ?? 1;
    const [width, height] = [video.shown[0] / scale, video.shown[1] / scale];
    const turned = video.shown[0] !== video.width;

    try {
      const tab = await browser.newPage();
      await tab.goto(server.url.href);
      const got = await tab.evaluate(
        async ({ page, worker, n, stream, size }) => {
          const support: typeof PageSupport = await import(page);
          const media = support.startMedia(worker);
          const res = await fetch(`/test/fixtures/${n}`);
          const blob = await res.blob();
          const opened = await media.request({ type: "open", file: new File([blob], n) });
          if (opened.type !== "opened") throw new Error(`${n}: ${opened.type}`);
          const params = opened.video[stream];
          if (!params) throw new Error(`${n}: no parameters for stream ${stream}`);
          const result = await support.render(media, stream, params, size);
          media.stop();
          return result;
        },
        {
          page: PAGE,
          worker: MEDIA_WORKER,
          n: file,
          stream: video.id,
          size: { times, width, height },
        },
      );
      expect(got.shown.map((s) => s.drawn)).toEqual(drawn);
      const ids = got.shown.filter((s) => s.drawn).map((s) => s.id);
      // A turned frame's number is not where the reader looks: it is counted, and its grid shows
      // the turn.
      if (turned) expect(ids.length).toBe(frames.length);
      else expect(ids).toEqual(frames);
      const r = correlation(got.grid, video.grid);
      expect(r, `${file} grid ${JSON.stringify(got.grid)}`).toBeGreaterThan(MIN_CORRELATION);
      const differences = got.grid.map((g, i) => Math.abs(g - (video.grid[i] ?? 0)));
      const difference = differences.reduce((sum, d) => sum + d, 0) / differences.length;
      expect(difference, `${file} grid ${JSON.stringify(got.grid)}`).toBeLessThan(
        MAX_LEVEL_DIFFERENCE,
      );
    } finally {
      await browser.close();
    }
  }, 60_000);

  // Through a packet ring of 4 KiB and a ring of 64 KiB to the video decode worker, its larger
  // packets go in pieces, a frame of FFmpeg's video handed over in parts as room frees.
  test(`shows ${file} through rings smaller than its packets`, async () => {
    const browser = await launch();
    const { frames, times } = plan(video);
    const scale = video.scale ?? 1;
    const [width, height] = [video.shown[0] / scale, video.shown[1] / scale];

    try {
      const tab = await browser.newPage();
      await tab.goto(server.url.href);
      const got = await tab.evaluate(
        async ({ page, worker, n, stream, size }) => {
          const support: typeof PageSupport = await import(page);
          const media = support.startMedia(worker);
          const res = await fetch(`/test/fixtures/${n}`);
          const blob = await res.blob();
          const opened = await media.request({ type: "open", file: new File([blob], n) });
          if (opened.type !== "opened") throw new Error(`${n}: ${opened.type}`);
          const params = opened.video[stream];
          if (!params) throw new Error(`${n}: no parameters for stream ${stream}`);
          const rings = { packets: 1 << 12, decoders: support.startDecoders(1 << 16) };
          const result = await support.render(media, stream, params, size, rings);
          media.stop();
          return result;
        },
        {
          page: PAGE,
          worker: MEDIA_WORKER,
          n: file,
          stream: video.id,
          size: { times, width, height },
        },
      );
      const ids = got.shown.filter((s) => s.drawn).map((s) => s.id);
      if (video.shown[0] === video.width) expect(ids).toEqual(frames);
      else expect(ids.length).toBe(frames.length);
    } finally {
      await browser.close();
    }
  }, 60_000);

  // FFmpeg's frames are always read from its memory.
  if (!video.codecString) continue;

  test(`draws ${file} straight from the GPU as from its planes, where it measures so`, async () => {
    const browser = await launch();

    try {
      const tab = await browser.newPage();
      await tab.goto(server.url.href);
      const got = await tab.evaluate(
        async ({ page, worker, n, stream }) => {
          const support: typeof PageSupport = await import(page);
          const media = support.startMedia(worker);
          const res = await fetch(`/test/fixtures/${n}`);
          const blob = await res.blob();
          const opened = await media.request({ type: "open", file: new File([blob], n) });
          if (opened.type !== "opened") throw new Error(`${n}: ${opened.type}`);
          const params = opened.video[stream];
          if (!params) throw new Error(`${n}: no parameters for stream ${stream}`);
          if (params.decoder !== "webcodecs") throw new Error(`${n}: ${params.decoder}`);

          const result = await support.compareRoutes(media, stream, params);
          media.stop();
          return result;
        },
        { page: PAGE, worker: MEDIA_WORKER, n: file, stream: video.id },
      );

      // Drawn from its planes, which the test above checks, when this machine's GPU measures the
      // frame unlike them, or still unmeasured when the first frame is too grey to decide.
      // oxlint-disable-next-line repo/no-conditional-expect -- the route depends on the machine's GPU and the frame
      if (!got.off) return;

      const [median = Infinity, p95 = Infinity] = got.off;
      expect(median, `${file} via ${got.via}`).toBeLessThanOrEqual(MAX_IMPORTED_OFF[0] ?? 0);
      expect(p95, `${file} via ${got.via}`).toBeLessThanOrEqual(MAX_IMPORTED_OFF[1] ?? 0);
    } finally {
      await browser.close();
    }
  }, 60_000);
}

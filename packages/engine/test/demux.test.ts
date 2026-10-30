// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The media worker's demux pump in Chromium: through a ring much smaller than each file, and
// through one smaller than most packets, which go in pieces, every stream's packets
// (timestamps, key flag, size and bytes) equal native ffprobe's (test/fixtures/expected.json);
// and a pump that fails ends the ring with FAILED.
// Usage: bun run test.

import { afterAll, expect, test } from "bun:test";
import { launch } from "./support/browsers";
import { MEDIA_WORKER, PAGE, serveEngine } from "./support/serve";
import type * as PageSupport from "./support/page";

interface Hash {
  id: number;
  packets: number;
  packetsSha256: string;
}

const expected: Record<string, { packetDts: boolean; video: Hash; audio?: Hash }> = await Bun.file(
  new URL("fixtures/expected.json", import.meta.url),
).json();
const fixtures = Object.entries(expected).map(([name, e]) => ({
  name,
  dts: e.packetDts,
  streams: e.audio ? [e.video.id, e.audio.id] : [e.video.id],
}));
const server = await serveEngine("<!doctype html><title>test</title>");

afterAll(() => server.stop(true));

// 256 KiB: room for an uncompressed frame, and smaller than the larger fixtures, so records
// wrap and the pump waits. 4 KiB: a packet over 2 KiB goes in pieces.
for (const capacity of [1 << 18, 1 << 12]) {
  test(`demuxes every fixture as ffprobe does, through a ring of ${capacity >> 10} KiB`, async () => {
    const browser = await launch();

    try {
      const tab = await browser.newPage();
      await tab.goto(server.url.href);

      const hashes = await tab.evaluate(
        async ({ page, worker, files, size }) => {
          const support: typeof PageSupport = await import(page);
          const media = support.startMedia(worker);
          const all: Record<string, Awaited<ReturnType<typeof support.hashRing>>> = {};

          for (const { name: n, dts, streams } of files) {
            const res = await fetch(`/test/fixtures/${n}`);
            const blob = await res.blob();
            await media.request({ type: "open", file: new File([blob], n) });
            const ring = support.createRing(size);
            const hashed = support.hashRing(ring, dts);
            await media.request({ type: "demux", ring, streams, from: 0 });
            all[n] = await hashed;
          }

          media.stop();
          return all;
        },
        { page: PAGE, worker: MEDIA_WORKER, files: fixtures, size: capacity },
      );

      const want = (h: Hash) => ({ packets: h.packets, packetsSha256: h.packetsSha256 });

      for (const [file, { video, audio }] of Object.entries(expected)) {
        const got = hashes[file];
        if (typeof got !== "object") throw new Error(`${file}: ${String(got)}`);
        expect(got[video.id], `${file} video`).toEqual(want(video));
        // Without audio, nothing besides the video.
        const other = audio?.id ?? Object.keys(got).find((id) => Number(id) !== video.id);
        expect(other === undefined ? undefined : got[Number(other)], `${file} audio`).toEqual(
          audio && want(audio),
        );
      }
    } finally {
      await browser.close();
    }
  }, 120_000);
}

// The pump fails on a stream the file lacks.
test("a pump that fails ends the ring with FAILED", async () => {
  const browser = await launch();

  try {
    const tab = await browser.newPage();
    await tab.goto(server.url.href);

    const results = await tab.evaluate(
      async ({ page, worker }) => {
        const support: typeof PageSupport = await import(page);
        const media = support.startMedia(worker);
        const res = await fetch("/test/fixtures/h264-aac.mp4");
        const blob = await res.blob();
        await media.request({ type: "open", file: new File([blob], "h264-aac.mp4") });

        async function demux(capacity: number, streams: number[]) {
          const ring = support.createRing(capacity);
          const hashed = support.hashRing(ring, false);

          try {
            await media.request({ type: "demux", ring, streams, from: 0 });
            const ended = await hashed;
            return ["replied", ended];
          } catch (e) {
            const ended = await hashed;
            return [String(e), ended];
          }
        }

        const noStream = await demux(1 << 16, [7]);

        // A track of an asset whose file it was not given.
        async function trackOf(asset: string) {
          const clip = { clip: "", asset, video: 0, audio: undefined, in: 0, out: 1e6, offset: 0 };
          const ring = support.createRing(1 << 16);
          const pcm = support.createPcmRing(1 << 16, 2, 48_000);
          const read = {
            ring,
            pcm,
            from: 0,
            clips: [clip],
            files: {},
            opens: 0,
            end: 1e6,
            preroll: 0,
          };

          try {
            await media.request({ type: "track", ...read });
            return "replied";
          } catch (e) {
            return String(e);
          }
        }

        const noFile = await trackOf("a");
        media.stop();
        return { noStream, noFile };
      },
      { page: PAGE, worker: MEDIA_WORKER },
    );

    expect(results.noStream).toEqual(["Error: demux: no stream 7", "failed"]);
    expect(results.noFile).toBe("Error: track: no file for asset a");
  } finally {
    await browser.close();
  }
}, 60_000);

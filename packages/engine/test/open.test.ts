// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// engine.open in Chromium: for every fixture it reports what native
// ffprobe reports (test/fixtures/expected.json), and it rejects a file that is not media, an
// engine that is closed and a media worker that failed to load. Usage: bun run test.

import { afterAll, expect, test } from "bun:test";
import { serve } from "../../../tooling/test-server";
import { launch } from "./support/browsers";
import type { Track } from "../src/index";
import { ENTRY, PAGE, serveEngine } from "./support/serve";
import type * as EngineModule from "../src/index";
import type * as PageSupport from "./support/page";

interface Expected {
  format: string;
  duration: number;
  video: { id: number; codec: string; width: number; height: number };
  audio: { id: number; codec: string; sampleRate: number; channels: number };
}

const expected: Record<string, Expected> = await Bun.file(
  new URL("fixtures/expected.json", import.meta.url),
).json();
const html = "<!doctype html><title>test</title>";
const server = await serveEngine(html);
// The engine without the ffmpeg package, so the media worker fails to load.
const broken = serve(new URL("../", import.meta.url), html);

afterAll(async () => {
  await server.stop(true);
  await broken.stop(true);
});

test("opens every fixture", async () => {
  const browser = await launch();

  try {
    const tab = await browser.newPage();
    await tab.goto(server.url.href);

    // Each fixture's MediaInfo, or the error; and the error for a file that is not media.
    const { opened, notMedia } = await tab.evaluate(
      async ({ entry, page, names }) => {
        const engine: typeof EngineModule = await import(entry);
        const support: typeof PageSupport = await import(page);
        const started = await engine.createEngine({ canvas: document.createElement("canvas") });

        async function open(path: string) {
          const res = await fetch(path);
          const blob = await res.blob();
          const handle = await support.fileHandle(path.split("/").pop() ?? "", blob);

          try {
            const info = await started.open(handle);
            return info;
          } catch (e) {
            return String(e);
          }
        }

        const infos = [];

        for (const n of names) {
          const info = await open(`/test/fixtures/${n}`);
          infos.push(info);
        }

        const rejected = await open("/test/fixtures/expected.json");
        started.close();
        return { opened: infos, notMedia: rejected };
      },
      { entry: ENTRY, page: PAGE, names: Object.keys(expected) },
    );

    for (const [i, [file, e]] of Object.entries(expected).entries()) {
      const info = opened[i];
      if (typeof info !== "object") throw new Error(`${file}: ${String(info)}`);
      expect(info.format, file).toBe(e.format);
      // ffprobe prints the duration to the microsecond, the unit FFmpeg keeps it in.
      expect(info.duration, file).toBeCloseTo(e.duration, 6);
      const { id, codec, width, height } = e.video;
      const audio = e.audio;
      const tracks: Track[] = [
        { id, kind: "video", codec, width, height },
        {
          id: audio.id,
          kind: "audio",
          codec: audio.codec,
          sampleRate: audio.sampleRate,
          channels: audio.channels,
        },
      ];
      expect(info.tracks, file).toEqual(tracks.toSorted((a, b) => a.id - b.id));
    }

    expect(notMedia).toStartWith("Error: open: ");
  } finally {
    await browser.close();
  }
}, 60_000);

// Three opens of a file that is not media, the last one after close; two at once, the first
// replaced by the second; and an open that is still getting its file when its engine closes.
async function failures(url: URL) {
  const browser = await launch();

  try {
    const tab = await browser.newPage();
    await tab.goto(url.href);

    return await tab.evaluate(async (entry) => {
      const engine: typeof EngineModule = await import(entry);
      // Made here, not with test/support/page.ts, which the broken server does not serve.
      const root = await navigator.storage.getDirectory();
      const file = await root.getFileHandle("empty", { create: true });
      const writable = await file.createWritable();
      await writable.write(new Uint8Array(16));
      await writable.close();
      type Engine = Awaited<ReturnType<typeof engine.createEngine>>;

      // The info as JSON, or the error. It calls open before it first waits.
      async function attempt(e: Engine) {
        try {
          const info = await e.open(file);
          return JSON.stringify(info);
        } catch (error) {
          return String(error);
        }
      }

      const started = await engine.createEngine({ canvas: document.createElement("canvas") });
      const first = await attempt(started);
      const second = await attempt(started);
      const replaced = await Promise.all([attempt(started), attempt(started)]);
      started.close();
      const afterClose = await attempt(started);
      const other = await engine.createEngine({ canvas: document.createElement("canvas") });
      const pending = attempt(other);
      other.close();
      const closedPending = await pending;
      return { first, second, replaced, afterClose, closedPending };
    }, ENTRY);
  } finally {
    await browser.close();
  }
}

test("a closed engine rejects open", async () => {
  const results = await failures(server.url);
  expect(results.first).toStartWith("Error: open: ");
  expect(results.replaced[0]).toBe("AbortError: open: replaced");
  expect(results.replaced[1]).toStartWith("Error: open: ");
  expect(results.afterClose).toBe("Error: the engine is closed");
  expect(results.closedPending).toBe("Error: the engine is closed");
}, 60_000);

test("a media worker that fails to load rejects every open", async () => {
  const { first, second, afterClose } = await failures(broken.url);
  expect(first).toStartWith("Error: ");
  expect(first).not.toStartWith("Error: open: ");
  // The load error stays the reason, also after close.
  expect([second, afterClose]).toEqual([first, first]);
}, 60_000);

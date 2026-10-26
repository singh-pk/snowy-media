// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// What the decode benchmarks share: a Chromium page holding the benchmark media as disk-backed
// Files, a fresh worker per run over them, and writing the results.

import { Glob } from "bun";
import { chromium } from "playwright";
import { serve } from "../../../tooling/test-server";

const root = new URL("../", import.meta.url).pathname;

export const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[xs.length >> 1] ?? 0;

/**
 * Opens a page holding the files in bench/media that match `pattern`. `run(worker, message)`
 * starts a fresh module worker from `worker`, posts it `message` with the files, and resolves
 * with its answer; `close()` ends the browser and the server.
 */
export async function openBenchPage(pattern: string) {
  const media = await Array.fromAsync(new Glob(`bench/media/${pattern}`).scan(root));
  if (media.length === 0)
    throw new Error(`no ${pattern} media: run bun scripts/gen-bench-media.ts`);
  const server = serve(
    new URL("../", import.meta.url),
    '<!doctype html><title>bench</title><input type="file" multiple>',
  );
  const browser = await chromium.launch();
  const tab = await browser.newPage();
  tab.on("console", (m) => m.type() === "error" && console.error(m.text()));
  await tab.goto(server.url.href);
  await tab.locator("input").setInputFiles(media.toSorted().map((f) => root + f));

  function run<T>(worker: string, message: Record<string, unknown> = {}) {
    return tab.evaluate(
      (arg) =>
        new Promise<T>((resolve, reject) => {
          const w = new Worker(arg.worker, { type: "module" });
          w.addEventListener("message", (e) => {
            w.terminate();
            resolve(e.data);
          });
          w.addEventListener("error", (e) => reject(new Error(e.message)));
          const files = [...(document.querySelector("input")?.files ?? [])];
          w.postMessage({ ...arg.message, files });
        }),
      { worker, message },
    );
  }

  async function close() {
    await browser.close();
    await server.stop(true);
  }

  return { version: browser.version(), run, close };
}

// Writes `result` as JSON to `out` under the package, or to stdout without one.
export async function report(result: unknown, out: string | undefined) {
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (out) await Bun.write(root + out, json);
  else process.stdout.write(json);
}

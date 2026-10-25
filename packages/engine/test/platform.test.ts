// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// createEngine's platform check in Chromium: it starts where the baseline
// is met, and names the missing feature where it is not. Usage: bun run test.

import { afterAll, expect, test } from "bun:test";
import type { LaunchOptions, Page } from "playwright";
import { launch } from "./support/browsers";
import { ENTRY, serveEngine } from "./support/serve";
import type * as EngineModule from "../src/index";

const page = "<!doctype html><title>test</title>";
const isolated = await serveEngine(page);
const notIsolated = await serveEngine(page, { isolated: false });

afterAll(async () => {
  await isolated.stop(true);
  await notIsolated.stop(true);
});

// Opens `url` in a fresh browser and starts an engine: "ok", or the feature it names missing.
async function start(url: URL, options?: LaunchOptions) {
  const browser = await launch(options);

  try {
    const tab: Page = await browser.newPage();
    await tab.goto(url.href);

    return await tab.evaluate(async (entry) => {
      const engine: typeof EngineModule = await import(entry);

      try {
        const started = await engine.createEngine({ canvas: document.createElement("canvas") });
        started.close();
        return "ok";
      } catch (e) {
        return e instanceof engine.UnsupportedPlatformError ? e.feature : String(e);
      }
    }, ENTRY);
  } finally {
    await browser.close();
  }
}

test("starts on a cross-origin isolated page", async () => {
  const result = await start(isolated.url);
  expect(result).toBe("ok");
}, 60_000);

test("names cross-origin isolation when the page lacks it", async () => {
  const result = await start(notIsolated.url);
  expect(result).toBe("cross-origin-isolation");
}, 60_000);

test("names WebGPU when it is off", async () => {
  const result = await start(isolated.url, { args: ["--disable-features=WebGPU"] });
  expect(result).toBe("webgpu");
}, 60_000);

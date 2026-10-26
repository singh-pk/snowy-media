// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Runs a package's unit tests in Chromium: bundles each `test/**/*.unit.ts` file, with the
// workers they start (`support`), into test/dist/unit, serves the package cross-origin
// isolated, and loads each file in a worker (tooling/unit-worker.ts) of a page of its own. Each
// of the file's tests is then a bun:test test of its own, which has the worker run it: so the
// count, a failure and a hang all name the test. Bun only builds, serves and drives the
// browser; no test code runs in it. The browser is the Chromium build of the pinned Playwright
// version.

import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { Glob } from "bun";
import { chromium, type Page } from "playwright";
import { COVERAGE, type ScriptCoverage, watchWorker, writeReport } from "./coverage";
import { serve } from "./test-server";
import type { FromUnitWorker, ToUnitWorker } from "./unit-worker";

// How long a file may take to load, and a test to run, before it counts as hung. The load needs
// a limit of its own: its tests are registered only once their names are known.
const LOAD_MS = 30_000;
const TEST_MS = 10_000;

type Loaded = Extract<FromUnitWorker, { type: "loaded" }>;

// The page's side: the file's worker, with what it posted on loading and a call per test.
interface Unit {
  loaded: Promise<Loaded>;
  run: (index: number) => Promise<string[]>;
  /** Has the worker import its file. */
  start: () => void;
  /** Ends the worker, and with it a test still waiting, so no call is left as the page closes. */
  stop: () => void;
}

type WithUnit = typeof globalThis & { unit?: Unit };

// `promise`, settled: a test that hangs is abandoned, and the call it made rejects when its page
// closes, which must not fail whatever test runs then.
async function settled<T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  try {
    const value = await promise;
    return { value };
  } catch (error) {
    return { error };
  }
}

// Starts the worker for `url` in `tab`, once `ready` has; resolves with its test names, or a
// load that failed.
async function load(tab: Page, url: string, ready: Promise<void>): Promise<Loaded> {
  await tab.evaluate((worker) => {
    const unitWorker = new Worker(worker, { type: "module" });
    const loaded = Promise.withResolvers<Loaded>();
    const waiting = new Map<number, (failures: string[]) => void>();

    unitWorker.addEventListener("message", ({ data }: MessageEvent<FromUnitWorker>) => {
      if (data.type === "loaded") loaded.resolve(data);
      else {
        waiting.get(data.index)?.(data.failures);
        waiting.delete(data.index);
      }
    });

    // The worker itself failed: the load, or every test waiting.
    unitWorker.addEventListener("error", (e) => {
      const error = `${e.message} (${e.filename}:${e.lineno})`;
      loaded.resolve({ type: "loaded", names: [], error });
      for (const done of waiting.values()) done([error]);
    });

    function run(index: number) {
      const ran = Promise.withResolvers<string[]>();
      waiting.set(index, ran.resolve);
      unitWorker.postMessage(index satisfies ToUnitWorker);
      return ran.promise;
    }

    function start() {
      unitWorker.postMessage("start" satisfies ToUnitWorker);
    }

    function stop() {
      unitWorker.terminate();
      for (const done of waiting.values()) done(["stopped: it did not finish"]);
    }

    (globalThis as WithUnit).unit = { loaded: loaded.promise, run, start, stop };
  }, url);

  // The deadline covers waiting for `ready` too, which may never come.
  const hung = Promise.withResolvers<Loaded>();
  // oxlint-disable-next-line repo/no-timers -- a hang has no event; only a deadline can end it
  const deadline = setTimeout(
    () => hung.resolve({ type: "loaded", names: [], error: `did not load in ${LOAD_MS} ms` }),
    LOAD_MS,
  );
  const result = await Promise.race([started(tab, ready), hung.promise]);
  clearTimeout(deadline);
  return result;
}

// Has the worker in `tab` import its file once `ready` has, and resolves with what it posted.
async function started(tab: Page, ready: Promise<void>): Promise<Loaded> {
  const isReady = await settled(ready);
  if ("error" in isReady) return { type: "loaded", names: [], error: String(isReady.error) };
  await tab.evaluate(() => (globalThis as WithUnit).unit?.start());

  return await tab.evaluate(async () => {
    const unit = (globalThis as WithUnit).unit;
    if (!unit) throw new Error("no unit worker");
    return await unit.loaded;
  });
}

interface Options {
  /** Worker entry points the tests start, relative to the package, such as test/support/x.ts. */
  support?: string[];
}

/** Registers a test for each unit test of the package at `pkg`, in a describe per file. */
export async function runUnitTests(pkg: URL, { support = [] }: Options = {}) {
  const dir = Bun.fileURLToPath(pkg);
  const files = [...new Glob("test/**/*.unit.ts").scanSync(dir)].toSorted();
  const outdir = `${dir}test/dist/unit/`;
  // Emptied first, so a test never loads a stale bundle of a file since renamed.
  await rm(outdir, { recursive: true, force: true });
  const runner = await Bun.build({
    entrypoints: [Bun.fileURLToPath(new URL("unit-worker.ts", import.meta.url))],
    outdir: `${outdir}runner/`,
    target: "browser",
    format: "esm",
  });
  if (!runner.success) throw new AggregateError(runner.logs, "unit tests: runner build failed");
  const built = await Bun.build({
    entrypoints: [...files, ...support].map((f) => `${dir}${f}`),
    root: `${dir}test/`,
    outdir,
    target: "browser",
    format: "esm",
    sourcemap: "external",
  });
  if (!built.success) throw new AggregateError(built.logs, "unit tests: build failed");
  const server = serve(pkg, "<!doctype html><title>unit tests</title>");
  const browser = await chromium.launch();
  // What each file's worker ran, when coverage is collected.
  const scripts: ScriptCoverage[] = [];

  afterAll(async () => {
    await browser.close();
    await server.stop(true);
    if (COVERAGE) await writeReport(dir, scripts);
  });

  const loads = files.map(async (file) => {
    const tab = await browser.newPage();
    await tab.goto(server.url.href);
    const coverage = await (COVERAGE ? watchWorker(tab) : undefined);
    const bundle = `/test/dist/unit/${file.slice("test/".length, -".ts".length)}.js`;
    const url = `/test/dist/unit/runner/unit-worker.js?file=${encodeURIComponent(bundle)}`;
    const loaded = await load(tab, url, coverage?.started ?? Promise.resolve());
    return { file, tab, loaded, coverage };
  });

  const opened = await Promise.all(loads);

  for (const { file, tab, loaded, coverage } of opened) {
    describe(file, () => {
      // The test still running, if it has hung: the ones after it in the file wait behind it.
      // Once the file is done, a hung one, abandoned, has nothing left to report.
      const state = { running: "", done: false };

      afterAll(async () => {
        state.done = true;
        const taken = await settled(coverage?.take() ?? Promise.resolve([]));
        await tab.evaluate(() => (globalThis as WithUnit).unit?.stop());
        await tab.close();
        if ("error" in taken) throw taken.error;
        scripts.push(...taken.value);
      });

      // A file that fails to load, or registers nothing, is a failure of its own.
      if (loaded.error !== undefined || loaded.names.length === 0) {
        test("loads", () => {
          throw new Error(loaded.error ?? "registers no tests");
        });
      }

      for (const [index, name] of loaded.names.entries()) {
        test(
          name,
          async () => {
            if (state.running) throw new Error(`not run: "${state.running}" did not finish`);
            state.running = name;

            const ran = await settled(
              tab.evaluate(async (i) => {
                const unit = (globalThis as WithUnit).unit;
                if (!unit) throw new Error("no unit worker");
                return await unit.run(i);
              }, index),
            );

            state.running = "";
            if (state.done) return;
            if ("error" in ran) throw ran.error;
            expect(ran.value).toEqual([]);
          },
          TEST_MS,
        );
      }
    });
  }
}

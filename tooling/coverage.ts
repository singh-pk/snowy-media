// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Line coverage of a package's `src/`, from V8's block coverage of the worker each unit test
// file runs in (tooling/run-unit.ts), when SNOWY_COVERAGE=1. Playwright attaches to every worker
// and resumes it at once, so a worker can't be held until coverage starts: the unit worker waits
// for a message instead, sent once it has. A line is covered when code that maps to it ran in
// any file's worker. Which lines hold code comes from building each `src/` file on its own,
// since a test's bundle leaves out what it doesn't import.

import { rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Glob } from "bun";
import type { Page } from "playwright";

export const COVERAGE = process.env.SNOWY_COVERAGE === "1";

interface Range {
  startOffset: number;
  endOffset: number;
  count: number;
}

export interface ScriptCoverage {
  url: string;
  functions: Array<{ ranges: Range[] }>;
}

/** Per `src/` file: the lines that hold code, and those of them that ran. */
export type Report = Record<string, { lines: number; covered: number; uncovered: number[] }>;

/**
 * Starts V8 coverage in the next worker `tab` starts. `started` resolves once it runs, and
 * `take` returns what ran since, until the worker ends.
 */
export async function watchWorker(tab: Page) {
  const cdp = await tab.context().newCDPSession(tab);
  // The commands waiting on a reply; only takePreciseCoverage's result is read.
  const replies = new Map<number, PromiseWithResolvers<{ result?: ScriptCoverage[] }>>();
  const started = Promise.withResolvers<void>();
  const state = { session: "", id: 0 };

  // The worker is reached through the page's session, one message inside another.
  function send(method: string, params = {}) {
    const id = ++state.id;
    const reply = Promise.withResolvers<{ result?: ScriptCoverage[] }>();
    replies.set(id, reply);
    void post(JSON.stringify({ id, method, params }));
    return reply.promise;
  }

  async function post(message: string) {
    try {
      await cdp.send("Target.sendMessageToTarget", { sessionId: state.session, message });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // Every command still waiting fails, as does a start not yet made.
  function fail(error: Error) {
    for (const reply of replies.values()) reply.reject(error);
    replies.clear();
    started.reject(error);
  }

  interface Reply {
    id: number;
    result?: { result?: ScriptCoverage[] };
    error?: { message: string };
  }

  cdp.on("Target.receivedMessageFromTarget", ({ message }) => {
    const { id, result, error }: Reply = JSON.parse(message);
    const reply = replies.get(id);
    replies.delete(id);
    if (error) reply?.reject(new Error(`coverage: ${error.message}`));
    else reply?.resolve(result ?? {});
  });

  async function start(sessionId: string) {
    state.session = sessionId;

    try {
      await send("Profiler.enable");
      await send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
      started.resolve();
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  cdp.on("Target.attachedToTarget", ({ sessionId, targetInfo }) => {
    if (targetInfo.type === "worker" && state.session === "") void start(sessionId);
  });

  cdp.on("Target.detachedFromTarget", ({ sessionId }) => {
    if (sessionId === state.session) fail(new Error("coverage: the worker ended first"));
  });

  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false });

  async function take() {
    const taken = await send("Profiler.takePreciseCoverage");
    return taken.result ?? [];
  }

  return { started: started.promise, take };
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// The numbers in one segment of a source map's `mappings`, as base64 VLQs.
function vlqs(segment: string) {
  const values: number[] = [];
  const at = { value: 0, shift: 0 };

  for (const char of segment) {
    const digit = BASE64.indexOf(char);
    at.value += (digit & 31) << at.shift;
    at.shift += 5;
    if (digit & 32) continue;
    values.push(at.value & 1 ? -(at.value >>> 1) : at.value >>> 1);
    at.value = 0;
    at.shift = 0;
  }

  return values;
}

/** Each mapped position of a source map: the generated line and column, and the source line. */
function* positions(mappings: string) {
  const at = { source: 0, line: 0, column: 0 };

  for (const [generatedLine, line] of mappings.split(";").entries()) {
    let column = 0;

    for (const segment of line.split(",")) {
      if (segment === "") continue;
      const [gc = 0, source, sourceLine, sourceColumn = 0] = vlqs(segment);
      column += gc;
      if (source === undefined || sourceLine === undefined) continue;
      at.source += source;
      at.line += sourceLine;
      at.column += sourceColumn;
      yield { generatedLine, column, source: at.source, line: at.line + 1 };
    }
  }
}

interface SourceMap {
  sources: string[];
  mappings: string;
}

// The `src/` file a source map's source is, relative to the package, or "" for any other.
function srcFile(dir: string, out: string, source: string) {
  const file = relative(dir, resolve(out, source)).replaceAll("\\", "/");
  return file.startsWith("src/") ? file : "";
}

/** The lines of each `src/` file that code in `js` maps to, with what ran there, if known. */
// Bun names a source relative to the build's output folder `out`, not to the map.
async function mappedLines(dir: string, out: string, js: string, count?: (at: number) => number) {
  const map: SourceMap = await Bun.file(`${js}.map`).json();
  const code = await Bun.file(js).text();
  // In UTF-16 units, as V8's offsets and source map columns count.
  const lineStarts = [0];

  for (let i = code.indexOf("\n"); i !== -1; i = code.indexOf("\n", i + 1)) {
    lineStarts.push(i + 1);
  }

  const files = map.sources.map((source) => srcFile(dir, out, source));
  const lines = new Map<string, Map<number, boolean>>();

  for (const p of positions(map.mappings)) {
    const file = files[p.source];
    if (!file) continue;
    const ran = (count?.((lineStarts[p.generatedLine] ?? 0) + p.column) ?? 0) > 0;
    const of = lines.get(file) ?? new Map<number, boolean>();
    lines.set(file, of);
    of.set(p.line, (of.get(p.line) ?? false) || ran);
  }

  return lines;
}

/**
 * The count at each offset of a script, asked for in rising order: the count of the innermost
 * range around it, as V8's ranges nest.
 */
function counter(script: ScriptCoverage) {
  const ranges = script.functions
    .flatMap((f) => f.ranges)
    .toSorted((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const open: Range[] = [];
  const next = { index: 0 };

  return (offset: number) => {
    for (; next.index < ranges.length; next.index++) {
      const range = ranges[next.index];
      if (!range || range.startOffset > offset) break;
      while ((open.at(-1)?.endOffset ?? Infinity) <= range.startOffset) open.pop();
      open.push(range);
    }

    while ((open.at(-1)?.endOffset ?? Infinity) <= offset) open.pop();
    return open.at(-1)?.count ?? 0;
  };
}

// The lines that hold code in each `src/` file, from a build of every one on its own.
async function codeLines(dir: string) {
  const out = join(dir, "coverage/code/");

  try {
    // With `/` on every platform, as the names from source maps have.
    const entries = [...new Glob("src/**/*.ts").scanSync(dir)]
      .filter((f) => !f.endsWith(".d.ts"))
      .map((f) => f.replaceAll("\\", "/"));
    const built = await Bun.build({
      entrypoints: entries.map((f) => join(dir, f)),
      root: dir,
      outdir: out,
      target: "browser",
      format: "esm",
      sourcemap: "external",
    });
    if (!built.success) throw new AggregateError(built.logs, "coverage: build failed");
    const lines = new Map<string, Set<number>>();

    for (const entry of entries) {
      const js = join(out, entry.replace(/\.ts$/, ".js"));
      const mapped = await mappedLines(dir, out, js);
      lines.set(entry, new Set(mapped.get(entry)?.keys()));
    }

    return lines;
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

/** Writes `coverage/unit.json` for the package at `dir` from what the unit tests' workers ran. */
export async function writeReport(dir: string, scripts: ScriptCoverage[]) {
  const ran = new Map<string, Set<number>>();

  for (const script of scripts) {
    // A script made by `eval` or `new Function` has no URL, and no bundle to map it through.
    if (!URL.canParse(script.url)) continue;
    const path = decodeURIComponent(new URL(script.url).pathname);
    // The bundles of test files and their workers; the runner is tooling, not the package.
    const isTest =
      path.startsWith("/test/dist/unit/") && !path.startsWith("/test/dist/unit/runner/");
    if (!isTest || !path.endsWith(".js")) continue;
    const out = join(dir, "test/dist/unit/");
    const mapped = await mappedLines(dir, out, join(dir, path), counter(script));

    for (const [file, lines] of mapped) {
      const of = ran.get(file) ?? new Set<number>();
      ran.set(file, of);
      for (const [line, wasRun] of lines) if (wasRun) of.add(line);
    }
  }

  const report: Report = {};
  const code = await codeLines(dir);
  // Were Bun to name sources some other way, nothing would map, and every file would pass.
  const total = [...code.values()].reduce((sum, lines) => sum + lines.size, 0);
  if (total === 0) throw new Error("coverage: no line of src/ maps from its build");

  for (const [file, lines] of code) {
    const covered = ran.get(file) ?? new Set<number>();
    const uncovered = [...lines].filter((line) => !covered.has(line)).toSorted((a, b) => a - b);
    report[file] = { lines: lines.size, covered: lines.size - uncovered.length, uncovered };
  }

  await Bun.write(join(dir, "coverage/unit.json"), `${JSON.stringify(report, null, 2)}\n`);
}

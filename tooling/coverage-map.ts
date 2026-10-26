// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Maps V8's block coverage of a bundle back to the lines of a package's `src/` files, through
// the bundle's source map, and finds which lines of those files hold code at all, from a build
// of each one on its own (a test's bundle leaves out what it doesn't import).

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Glob } from "bun";

interface Range {
  startOffset: number;
  endOffset: number;
  count: number;
}

export interface ScriptCoverage {
  url: string;
  functions: Array<{ ranges: Range[] }>;
}

/** Per `src/` file, relative to the package: the lines that ran. */
export type Ran = Record<string, number[]>;

/** Per `src/` file: the lines that hold code, and those of them that ran. */
type Report = Record<string, { lines: number; covered: number; uncovered: number[] }>;

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
      // Bun starts most generated lines with a segment that repeats the position before it,
      // which would count the last line of a block that never ran as run by the code after it.
      const repeats = source === 0 && sourceLine === 0 && sourceColumn === 0;
      at.source += source;
      at.line += sourceLine;
      at.column += sourceColumn;
      if (repeats) continue;
      yield { generatedLine, column, source: at.source, line: at.line + 1 };
    }
  }
}

interface SourceMap {
  sources: string[];
  mappings: string;
}

// Bun names a source relative to the build's output folder, not to the map, and the map does
// not say which folder that was: it is the nearest one around the bundle, up to the package,
// against which every source is a file.
function outdirOf(dir: string, js: string, sources: string[]) {
  const root = resolve(dir);

  for (let out = dirname(js); !relative(root, out).startsWith(".."); out = dirname(out)) {
    if (sources.every((source) => existsSync(resolve(out, source)))) return out;
  }

  throw new Error(`coverage: the sources of ${js}.map are not files from any folder around it`);
}

// The `src/` file a source map's source is, relative to the package, or "" for any other.
function srcFile(dir: string, out: string, source: string) {
  const file = relative(dir, resolve(out, source)).replaceAll("\\", "/");
  return file.startsWith("src/") ? file : "";
}

/**
 * The lines of each `src/` file of the package at `dir` that code in the bundle `js` maps to,
 * with whether it ran, by `count` at each offset of the bundle.
 */
export async function mappedLines(dir: string, js: string, count?: (at: number) => number) {
  const map: SourceMap = await Bun.file(`${js}.map`).json();
  const code = await Bun.file(js).text();
  // In UTF-16 units, as V8's offsets and source map columns count.
  const lineStarts = [0];

  for (let i = code.indexOf("\n"); i !== -1; i = code.indexOf("\n", i + 1)) {
    lineStarts.push(i + 1);
  }

  const out = outdirOf(dir, js, map.sources);
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
export function counter(script: ScriptCoverage) {
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

/** The lines that hold code in each `src/` file of the package at `dir`. */
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
      const mapped = await mappedLines(dir, js);
      lines.set(entry, new Set(mapped.get(entry)?.keys()));
    }

    return lines;
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

/** The report of each `src/` file of the package at `dir`, from the lines that ran. */
export async function report(dir: string, ran: Ran) {
  const code = await codeLines(dir);
  // Were Bun to name sources some other way, nothing would map, and every file would pass.
  const total = [...code.values()].reduce((sum, lines) => sum + lines.size, 0);
  if (total === 0) throw new Error("coverage: no line of src/ maps from its build");
  const result: Report = {};

  for (const [file, lines] of code) {
    const covered = new Set(ran[file]);
    const uncovered = [...lines].filter((line) => !covered.has(line)).toSorted((a, b) => a - b);
    result[file] = { lines: lines.size, covered: lines.size - uncovered.length, uncovered };
  }

  return result;
}

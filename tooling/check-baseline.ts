// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Holds code that predates the size and duplication limits to what it was: per file, the
// functions over 80 lines, the functions with more than 4 parameters and whether the file is
// over 600 lines (blank lines and comments not counted), and per pair of files, the blocks of 8
// lines and 60 tokens or more they share (jscpd, configured in .jscpd.json). A count above `lint-baseline.json`
// fails, as does a file the baseline doesn't list. A count below it fails too, so the baseline
// never goes stale: `--update` lowers it to what the code is now, and never raises it. A file
// that is renamed or moved takes its entries with it, by hand, in the same commit.
// Usage: bun tooling/check-baseline.ts [--update]

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BASELINE = join(import.meta.dir, "lint-baseline.json");
const BIN = join(ROOT, "node_modules/.bin");

const LIMITS = {
  "max-lines": ["error", { max: 600, skipBlankLines: true, skipComments: true }],
  "max-lines-per-function": ["error", { max: 80, skipBlankLines: true, skipComments: true }],
  "max-params": ["error", 4],
};

type Counts = Record<string, Record<string, number>>;

function add(counts: Counts, kind: string, key: string) {
  const of = (counts[kind] ??= {});
  of[key] = (of[key] ?? 0) + 1;
}

// Runs a tool and returns its output. What it writes to stderr is shown only when it fails
// without output: oxlint exits 1 for what it reports, which is not a failure here.
async function run(command: string[]) {
  const child = Bun.spawn(command, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  const code = await child.exited;
  if (code !== 0 && output.trim() === "") throw new Error(`${command[0]} failed:\n${errors}`);
  return output;
}

// The limits alone, over the files the repository's lint config covers.
async function lintCounts(dir: string, counts: Counts) {
  const repo: { ignorePatterns: string[] } = await Bun.file(join(ROOT, ".oxlintrc.json")).json();
  const config = join(dir, "limits.json");
  await Bun.write(config, JSON.stringify({ categories: { correctness: "off" }, rules: LIMITS }));
  // In a config, ignore patterns are relative to its folder; on the command line, to the root.
  const ignores = repo.ignorePatterns.map((p) => `--ignore-pattern=${p}`);
  const command = [join(BIN, "oxlint"), "-c", config, ...ignores, "--format", "json"];
  const output = await run(command);
  const {
    diagnostics,
  }: { diagnostics: Array<{ code?: string; filename: string; message: string }> } =
    JSON.parse(output);

  for (const { code, filename, message } of diagnostics) {
    // A report without a rule is oxlint failing, such as on a file it can't read.
    if (code === undefined) throw new Error(`oxlint: ${message}`);
    add(counts, code.replace(/^eslint\((.*)\)$/, "$1"), filename);
  }
}

async function duplicationCounts(dir: string, counts: Counts) {
  await run([join(BIN, "jscpd"), "--config", ".jscpd.json", "--reporters", "json", "-o", dir]);
  const report: {
    duplicates: Array<{ firstFile: { name: string }; secondFile: { name: string } }>;
  } = await Bun.file(join(dir, "jscpd-report.json")).json();

  for (const { firstFile, secondFile } of report.duplicates) {
    const pair = [firstFile.name, secondFile.name].toSorted();
    add(counts, "duplication", [...new Set(pair)].join(" and "));
  }
}

const dir = await mkdtemp(join(tmpdir(), "snowy-baseline-"));
const now: Counts = {};

try {
  await lintCounts(dir, now);
  await duplicationCounts(dir, now);
} finally {
  await rm(dir, { recursive: true, force: true });
}

const baseline: Counts = await Bun.file(BASELINE).json();
const kinds = ["duplication", ...Object.keys(LIMITS)];
const rose: string[] = [];
const fell: string[] = [];
const lowered: Counts = {};

for (const kind of kinds) {
  const was = baseline[kind] ?? {};
  const is = now[kind] ?? {};

  // Sorted, so the baseline is written in a stable order.
  for (const key of [...new Set([...Object.keys(was), ...Object.keys(is)])].toSorted()) {
    const before = was[key] ?? 0;
    const after = is[key] ?? 0;
    if (after > before) rose.push(`${key}: ${kind} ${after}, up from ${before}`);
    if (after < before) fell.push(`${key}: ${kind} ${after}, down from ${before}`);
    if (Math.min(before, after) > 0) (lowered[kind] ??= {})[key] = Math.min(before, after);
  }
}

if (process.argv.includes("--update")) {
  await Bun.write(BASELINE, `${JSON.stringify(lowered, null, 2)}\n`);
  console.log(
    "Lowered tooling/lint-baseline.json to the code as it is; counts that rose still fail.",
  );
  process.exit(0);
}

for (const problem of [...rose, ...fell]) console.error(problem);

if (rose.length > 0) {
  console.error(
    "Split the function or file, use an options object, or share the repeated code (AGENTS.md rule 7). A renamed or moved file takes its entries with it: edit the baseline by hand.",
  );
}

if (fell.length > 0) {
  console.error("Run `bun tooling/check-baseline.ts --update` to lower the baseline.");
}

if (rose.length + fell.length > 0) process.exit(1);
console.log("Size and duplication are within tooling/lint-baseline.json");

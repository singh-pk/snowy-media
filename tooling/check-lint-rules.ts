// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Checks every repository lint rule against its fixtures: in `bad.ts` the rule reports exactly
// the lines its `// expected lines:` comment lists, and in `good.ts` nothing. Other rules'
// reports are left out. A rule without fixtures fails.
// Usage: bun tooling/check-lint-rules.ts

import { existsSync } from "node:fs";

const ROOT = new URL("oxlint-rules/", import.meta.url);
const FIXTURES = new URL("fixtures/", ROOT);
const CONFIG = new URL("fixtures.json", ROOT).pathname;
const OXLINT = new URL("../node_modules/.bin/oxlint", import.meta.url).pathname;

interface Diagnostic {
  code: string;
  labels: { span: { line: number } }[];
}

async function lint(path: string) {
  const run = Bun.spawn([OXLINT, "-c", CONFIG, "--format", "json", path], { stdout: "pipe" });
  const output = await new Response(run.stdout).json();
  const { diagnostics }: { diagnostics: Diagnostic[] } = output;
  return diagnostics;
}

const lineOf = (d: Diagnostic) => d.labels[0]?.span.line ?? 0;
const describe = (diagnostics: Diagnostic[]) =>
  diagnostics.map((d) => `${d.code} on line ${lineOf(d)}`).join(", ");

async function check(rule: string) {
  const dir = new URL(`${rule}/`, FIXTURES).pathname;

  if (!existsSync(`${dir}bad.ts`) || !existsSync(`${dir}good.ts`)) {
    return [`${rule}: no fixtures/${rule}/bad.ts and good.ts`];
  }

  const source = await Bun.file(`${dir}bad.ts`).text();
  const listed = /\/\/ expected lines: ([\d ]+)/.exec(source)?.[1];
  const expected = (listed ?? "").trim().split(/\s+/).map(Number).join(" ");
  // Each fixture tests its own rule; the other rules' reports are not its concern.
  const own = (d: Diagnostic) => d.code === `repo(${rule})`;
  const badReports = await lint(`${dir}bad.ts`);
  const goodReports = await lint(`${dir}good.ts`);
  const bad = badReports.filter(own);
  const good = goodReports.filter(own);
  const reported = bad
    .map(lineOf)
    .toSorted((a, b) => a - b)
    .join(" ");
  const problems: string[] = [];
  if (!listed) problems.push("bad.ts has no `// expected lines:` comment");
  if (reported !== expected) problems.push(`bad.ts: lines ${reported || "none"}, not ${expected}`);
  if (good.length > 0) problems.push(`good.ts: ${describe(good)}`);
  return problems.map((p) => `${rule}: ${p}`);
}

// The plugin is plain JavaScript, so it is imported by URL, untyped.
const plugin: { default: { rules: Record<string, unknown> } } = await import(
  new URL("index.js", ROOT).href
);
const rules = Object.keys(plugin.default.rules);
const results = await Promise.all(rules.map(check));
const failing = results.filter((r) => r.length > 0);
for (const problem of failing.flat()) console.error(problem);
console.log(`${rules.length - failing.length}/${rules.length} rules pass their fixtures`);
if (failing.length > 0) process.exit(1);

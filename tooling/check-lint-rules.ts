// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Checks every repository lint rule, for oxlint and for markdownlint, against its fixtures: in
// `bad.ts` (or `bad.md`) the rule reports exactly the lines its `expected lines:` comment
// lists, and in `good.ts` (or `good.md`) nothing. Other rules' reports are left out. A rule
// without fixtures fails. tooling/exceptions.ts, which reads exceptions from outside the
// linter, is checked the same way against `fixtures/exceptions/`.
// Usage: bun tooling/check-lint-rules.ts

import { existsSync, readdirSync } from "node:fs";
import { lint as lintMarkdown } from "markdownlint/promise";
import type { Rule } from "markdownlint";
import { exceptions } from "./exceptions";

const ROOT = new URL("oxlint-rules/", import.meta.url);
const MD_ROOT = new URL("markdownlint-rules/", import.meta.url);
const MD_FIXTURES = new URL("fixtures/", MD_ROOT);
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

// A markdown rule, checked the same way against `bad.md` and `good.md`, with `<!-- expected
// lines: -->` in `bad.md`.
async function checkMarkdown(name: string) {
  const dir = new URL(`${name}/`, MD_FIXTURES).pathname;
  const bad = `${dir}bad.md`;
  const good = `${dir}good.md`;
  if (!existsSync(bad) || !existsSync(good))
    return [`${name}: no fixtures/${name}/bad.md and good.md`];
  const rule: { default: Rule } = await import(new URL(`${name}.js`, MD_ROOT).href);
  const config = { default: false, [name]: true };
  const results = await lintMarkdown({ files: [bad, good], customRules: [rule.default], config });
  const source = await Bun.file(bad).text();
  const listed = /<!-- expected lines: ([\d ]+)-->/.exec(source)?.[1];
  const expected = (listed ?? "").trim().split(/\s+/).map(Number).join(" ");
  const reported = (results[bad] ?? []).map((e) => e.lineNumber).join(" ");
  const problems: string[] = [];
  if (!listed) problems.push("bad.md has no `<!-- expected lines: -->` comment");
  if (reported !== expected) problems.push(`bad.md: lines ${reported || "none"}, not ${expected}`);
  const extra = (results[good] ?? []).map((e) => `line ${e.lineNumber}`).join(", ");
  if (extra !== "") problems.push(`good.md: ${extra}`);
  return problems.map((p) => `${name}: ${p}`);
}

// tooling/exceptions.ts, against `fixtures/exceptions/` as a rule against its own.
async function checkExceptions() {
  const dir = new URL("exceptions/", FIXTURES).pathname;
  const source = await Bun.file(`${dir}bad.ts`).text();
  const good = await Bun.file(`${dir}good.ts`).text();
  const listed = /\/\/ expected lines: ([\d ]+)/.exec(source)?.[1] ?? "";
  const expected = listed.trim().split(/\s+/).map(Number).join(" ");
  const reported = exceptions(source)
    .map((p) => p.line)
    .toSorted((a, b) => a - b)
    .join(" ");
  const extra = exceptions(good).map((p) => `line ${p.line}: ${p.text}`);
  const problems =
    reported === expected ? [] : [`bad.ts: lines ${reported || "none"}, not ${expected}`];
  if (extra.length > 0) problems.push(`good.ts: ${extra.join(", ")}`);
  return problems.map((p) => `exceptions: ${p}`);
}

// The plugin is plain JavaScript, so it is imported by URL, untyped.
const plugin: { default: { rules: Record<string, unknown> } } = await import(
  new URL("index.js", ROOT).href
);
const markdownRules = readdirSync(MD_ROOT)
  .filter((file) => file.endsWith(".js"))
  .map((file) => file.slice(0, -3));
const rules = [...Object.keys(plugin.default.rules), ...markdownRules, "exceptions"];
const results = await Promise.all([
  ...Object.keys(plugin.default.rules).map(check),
  ...markdownRules.map(checkMarkdown),
  checkExceptions(),
]);
const failing = results.filter((r) => r.length > 0);
for (const problem of failing.flat()) console.error(problem);
console.log(`${rules.length - failing.length}/${rules.length} rules pass their fixtures`);
if (failing.length > 0) process.exit(1);

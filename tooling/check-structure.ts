// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Checks what each package says about itself against what it holds:
// - every file under `src/` has a row in the Map table of the package's AGENTS.md, which says
//   what the file is for, and every row names a path that exists. A row may be a glob
//   (`src/*.c`) or a folder (`test/`), which covers what is in it, though not all of `src/`;
// - the README is at most 150 lines, draws the package in a ```mermaid block, and ends with its
//   licence.
// Usage: bun tooling/check-structure.ts

import { Glob } from "bun";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const README_LINES = 150;

// The paths in the first column of the `## Map` table.
function mapPaths(agents: string) {
  const section = agents.split(/^## /m).find((s) => /^Map\s*\n/.test(s)) ?? "";
  const cells = section.split("\n").map((line) => /^\|([^|]*)\|/.exec(line)?.[1] ?? "");
  return cells.flatMap((cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ""));
}

function covers(path: string, file: string) {
  if (path.endsWith("/")) return file.startsWith(path);
  return path.includes("*") ? new Glob(path).match(file) : path === file;
}

function exists(dir: string, path: string) {
  if (!path.includes("*")) return existsSync(join(dir, path));
  return !new Glob(path).scanSync({ cwd: dir }).next().done;
}

function checkMap(dir: string, agents: string) {
  const paths = mapPaths(agents);
  const src = [...new Glob("src/**/*").scanSync({ cwd: dir })];
  const problems: string[] = [];
  if (paths.length === 0) problems.push("AGENTS.md has no `## Map` table");

  for (const file of src) {
    if (!paths.some((path) => covers(path, file))) problems.push(`${file} has no Map row`);
  }

  for (const path of paths) {
    if (!exists(dir, path)) problems.push(`the Map row \`${path}\` names nothing that exists`);
    // A row for all of `src/`, as `src/` or `src/**/*.ts`, says nothing of any one file.
    const all = src.length > 1 && src.every((file) => covers(path, file));
    if (all) problems.push(`the Map row \`${path}\` covers all of src/; give each file its own`);
  }

  return problems;
}

// The lines outside fenced code blocks.
function outsideFences(lines: string[]) {
  let fence = "";

  return lines.filter((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    const opens = marker !== undefined && fence === "";
    const closes = marker !== undefined && marker.startsWith(fence) && line.trim() === marker;
    if (opens) fence = marker;
    else if (fence !== "" && closes) fence = "";
    return fence === "" && marker === undefined;
  });
}

function checkReadme(readme: string) {
  const lines = readme.trimEnd().split("\n");
  const headings = outsideFences(lines).filter((line) => line.startsWith("## "));
  const problems: string[] = [];

  if (lines.length > README_LINES) {
    problems.push(`README.md has ${lines.length} lines, more than ${README_LINES}`);
  }

  if (!lines.includes("```mermaid")) problems.push("README.md has no ```mermaid diagram");
  const last = headings.at(-1)?.trim() ?? "";
  if (!/^## Licen[cs]e$/.test(last)) problems.push("README.md does not end with ## Licence");
  return problems;
}

async function checkPackage(dir: string) {
  const missing = ["AGENTS.md", "README.md", "src"].filter((name) => !existsSync(join(dir, name)));
  if (missing.length > 0) return [`has no ${missing.join(", ")}`];
  const agents = await Bun.file(join(dir, "AGENTS.md")).text();
  const readme = await Bun.file(join(dir, "README.md")).text();
  return [...checkMap(dir, agents), ...checkReadme(readme)];
}

const packages = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const problems: string[] = [];

for (const name of packages) {
  const found = await checkPackage(join(ROOT, "packages", name));
  problems.push(...found.map((p) => `packages/${name}: ${p}`));
}

for (const problem of problems) console.error(problem);
if (problems.length > 0) process.exit(1);
console.log(`${packages.length} packages match their Map and README shape`);

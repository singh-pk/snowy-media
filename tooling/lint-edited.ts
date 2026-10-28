// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// An editor hook (`.claude/settings.json`, after Edit, MultiEdit and Write): lints and format-checks the
// file just edited, so a broken house rule shows at once rather than at commit. Exit code 2
// hands the report back to the editing tool. Type-aware rules and whole-repository checks are
// left to `bun run check`, which takes too long to run on every edit.
// Usage: piped the hook's JSON on stdin.

import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { commentBudget, type Change } from "./comment-budget";

const ROOT = join(import.meta.dir, "..");
const BIN = join(ROOT, "node_modules/.bin");

interface Edit {
  old_string?: string;
  new_string?: string;
}

const input: { tool_input?: Edit & { file_path?: string; content?: string; edits?: Edit[] } } =
  await Bun.stdin.json();
const path = input.tool_input?.file_path ?? "";
const file = relative(ROOT, path).replaceAll("\\", "/");
// A path on another drive comes back absolute, and is just as outside.
const outside =
  file.startsWith("..") || isAbsolute(file) || /(^|\/)(node_modules|dist)\//.test(file);

// Each tool that applies to the file, as the command that checks it. A file a tool's config
// ignores, such as a lint fixture, passes; markdownlint checks only this file, not its globs.
function commands() {
  const format = [join(BIN, "oxfmt"), "--check", "--no-error-on-unmatched-pattern", file];
  const lint = [
    join(BIN, "oxlint"),
    "--max-warnings",
    "0",
    "--no-error-on-unmatched-pattern",
    file,
  ];
  if (/\.(ts|js)$/.test(file)) return [lint, format];
  if (/\.jsonc?$/.test(file)) return [format];
  if (file.endsWith(".md")) return [[join(BIN, "markdownlint-cli2"), "--no-globs", file]];
  return [];
}

async function report(command: string[]) {
  const run = Bun.spawn(command, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(run.stdout).text();
  const err = await new Response(run.stderr).text();
  const code = await run.exited;
  return code === 0 ? "" : `${out}${err}`.trim();
}

const toChange = (e: Edit) => ({ before: e.old_string ?? "", after: e.new_string ?? "" });

// What the edit changed. A Write replaces the whole file, so it is measured against the last commit.
function changes(): Change[] {
  const tool = input.tool_input ?? {};
  const edits = tool.edits ?? (tool.new_string === undefined ? [] : [tool]);
  if (tool.content === undefined) return edits.map(toChange);
  const head = Bun.spawnSync(["git", "show", `HEAD:${file}`], { cwd: ROOT });
  const before = head.exitCode === 0 ? head.stdout.toString() : "";
  return [{ before, after: tool.content }];
}

if (outside || !existsSync(path)) process.exit(0);
const reports = await Promise.all(commands().map(report));
if (/^packages\/.*\.ts$/.test(file)) reports.push(commentBudget(changes()));
const failed = reports.filter((r) => r !== "");

if (failed.length > 0) {
  console.error(`${file} breaks a repository rule:\n${failed.join("\n")}`);
  process.exit(2);
}

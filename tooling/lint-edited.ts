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

const ROOT = join(import.meta.dir, "..");
const BIN = join(ROOT, "node_modules/.bin");

const input: { tool_input?: { file_path?: string } } = await Bun.stdin.json();
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

if (outside || !existsSync(path)) process.exit(0);
const reports = await Promise.all(commands().map(report));
const failed = reports.filter((r) => r !== "");

if (failed.length > 0) {
  console.error(`${file} breaks a repository rule:\n${failed.join("\n")}`);
  process.exit(2);
}

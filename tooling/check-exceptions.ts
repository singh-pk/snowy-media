// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Checks the exceptions to the checks in every TypeScript and JavaScript file, as
// tooling/exceptions.ts reads them. The lint rules' own fixtures, which show what the rules
// report, are left out.
// Usage: bun tooling/check-exceptions.ts

import { join } from "node:path";
import { $ } from "bun";
import { exceptions } from "./exceptions";

const ROOT = join(import.meta.dir, "..");

const listed = await $`git ls-files -- '*.ts' '*.js' '*.mjs'`.cwd(ROOT).text();
const files = listed
  .split("\n")
  .filter((f) => f !== "" && !f.startsWith("tooling/oxlint-rules/fixtures/"));
const problems: string[] = [];

for (const file of files) {
  const text = await Bun.file(join(ROOT, file)).text();
  for (const problem of exceptions(text)) problems.push(`${file}:${problem.line}: ${problem.text}`);
}

for (const problem of problems) console.error(problem);

if (problems.length > 0) {
  console.error("Narrow each exception to one line, or a marked block, and say why.");
  process.exit(1);
}

console.log(`${files.length} files: every exception is one line or a marked block, with a reason`);

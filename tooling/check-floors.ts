// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Fails if a pull request lowers a coverage floor: each package's `coverage-floor.json` is
// compared with its copy at `base`, and a file whose floor is below what it was there is
// reported. Lowering one is a choice the pull request states, with the `lowers-coverage`
// label, which skips this check in CI (.github/workflows/pr.yml).
// Usage: bun tooling/check-floors.ts <base commit>

import { join } from "node:path";
import { $, Glob } from "bun";

const base = process.argv[2] ?? "";

if (base === "") {
  console.error("Usage: bun tooling/check-floors.ts <base commit>");
  process.exit(1);
}

const root = join(import.meta.dir, "..");
const lowered: string[] = [];
// A base that is not a commit here fails, rather than reading as one with no floors.
const verified = await $`git rev-parse --verify --quiet ${`${base}^{commit}`}`
  .cwd(root)
  .quiet()
  .nothrow();

if (verified.exitCode !== 0) {
  console.error(`check-floors: ${base} is not a commit here; fetch it first`);
  process.exit(1);
}

// The floors at `base`, or none where the package had no floor file there.
async function floorsAt(path: string): Promise<Record<string, number>> {
  const there = await $`git cat-file -e ${`${base}:${path}`}`.cwd(root).quiet().nothrow();
  if (there.exitCode !== 0) return {};
  const shown = await $`git show ${`${base}:${path}`}`.cwd(root).text();
  return JSON.parse(shown);
}

for (const path of new Glob("packages/*/coverage-floor.json").scanSync(root)) {
  const now: Record<string, number> = await Bun.file(join(root, path)).json();
  const was = await floorsAt(path);

  for (const [file, floor] of Object.entries(now)) {
    const before = was[file];

    if (before !== undefined && floor < before) {
      lowered.push(`${path}: ${file} ${before}% → ${floor}%`);
    }
  }
}

for (const line of lowered) console.error(line);

if (lowered.length > 0) {
  console.error(
    "A floor went down. Test what lost its coverage, or say why in the pull request and label it lowers-coverage.",
  );
  process.exit(1);
}

console.log("No coverage floor is lower than at the base.");

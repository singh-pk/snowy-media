// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Holds a package's line coverage to its floors: each `src/` file's share of lines the unit
// tests run (tooling/coverage.ts, written by `SNOWY_COVERAGE=1 bun test`) may not fall below
// what `coverage-floor.json` lists for it, in whole percent. A file without a floor fails, as
// does a floor for a file that is gone. Coverage above a floor is only pointed out: `--update`
// raises the floors to it, never lowering one, adds new files at their coverage and drops the
// floors of files that are gone.
// Usage: bun tooling/check-coverage.ts <package> [--update]

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Report } from "./coverage";

const name = process.argv[2] ?? "";
const dir = join(import.meta.dir, "..", "packages", name);
const reportPath = join(dir, "coverage/unit.json");
const floorPath = join(dir, "coverage-floor.json");

if (name === "") {
  console.error("Usage: bun tooling/check-coverage.ts <package> [--update]");
  process.exit(1);
}

if (!existsSync(reportPath)) {
  console.error(`No ${reportPath}: run \`SNOWY_COVERAGE=1 bun test\` in the package first.`);
  process.exit(1);
}

const report: Report = await Bun.file(reportPath).json();
const written = existsSync(floorPath) ? Bun.file(floorPath).text() : "{}";
const floorText = await written;
const floors: Record<string, number> = JSON.parse(floorText);

// A file with no code has nothing to leave uncovered.
function percent(file: string) {
  const { lines = 0, covered = 0 } = report[file] ?? {};
  return lines === 0 ? 100 : Math.floor((100 * covered) / lines);
}

if (process.argv.includes("--update")) {
  const raised = Object.fromEntries(
    Object.keys(report)
      .toSorted()
      .map((file) => [file, Math.max(floors[file] ?? 0, percent(file))]),
  );
  await Bun.write(floorPath, `${JSON.stringify(raised, null, 2)}\n`);
  console.log(`Raised packages/${name}/coverage-floor.json to the coverage as it is.`);
  process.exit(0);
}

const problems: string[] = [];
const above: string[] = [];

for (const file of Object.keys(report).toSorted()) {
  const floor = floors[file];
  const now = percent(file);
  const uncovered = (report[file]?.uncovered ?? []).slice(0, 20).join(", ");

  if (floor === undefined) problems.push(`${file}: ${now}%, with no floor`);
  else if (now < floor)
    problems.push(`${file}: ${now}%, below its floor of ${floor}% (lines ${uncovered})`);
  else if (now > floor) above.push(`${file}: ${now}%, above its floor of ${floor}%`);
}

for (const file of Object.keys(floors)) {
  if (!(file in report)) problems.push(`${file}: a floor for a file with no code or none at all`);
}

for (const line of above) console.log(line);
if (above.length > 0)
  console.log(`Raise the floors: bun tooling/check-coverage.ts ${name} --update`);
for (const problem of problems) console.error(problem);

if (problems.length > 0) {
  console.error(
    "Test what the change leaves uncovered; a floor is lowered only by hand, with a reason.",
  );
  process.exit(1);
}

console.log(`packages/${name}: every src/ file is at or above its coverage floor`);

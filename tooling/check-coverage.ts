// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Holds a package's line coverage to its floors: each `src/` file's share of lines its tests
// run (tooling/coverage.ts, written by `SNOWY_COVERAGE=1 bun test`) may not fall below
// what `coverage-floor.json` lists for it, in whole percent. A file without a floor fails, as
// does a floor for a file that is gone. Coverage above a floor is only pointed out: `--update`
// raises the floors to it, never lowering one, adds new files at their coverage and drops the
// floors of files that are gone. The coverage is read once: a check, or an update, deletes it,
// so the next one needs a test run of its own and never counts an old run's.
// Usage: bun tooling/check-coverage.ts <package> [--update]

import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Glob } from "bun";
import { type Ran, report as reportOf } from "./coverage-map";

const name = process.argv[2] ?? "";
const dir = join(import.meta.dir, "..", "packages", name);
const ranDir = join(dir, "coverage/ran");
const floorPath = join(dir, "coverage-floor.json");

if (name === "") {
  console.error("Usage: bun tooling/check-coverage.ts <package> [--update]");
  process.exit(1);
}

const takes = existsSync(ranDir) ? [...new Glob("*.json").scanSync(ranDir)] : [];

if (takes.length === 0) {
  console.error(
    `No coverage in ${ranDir}: run \`SNOWY_COVERAGE=1 bun test\` in the package first.`,
  );
  process.exit(1);
}

// The takes of the last test run, the process that wrote the newest file, should runs
// have followed one another without a check between them.
async function writtenAt(take: string) {
  const info = await stat(join(ranDir, take));
  return info.mtimeMs;
}

const times = await Promise.all(takes.map(writtenAt));
const newest = takes[times.indexOf(Math.max(...times))] ?? "";
const run = `${newest.split("-")[0]}-`;
const ran: Ran = {};

for (const take of takes.filter((t) => t.startsWith(run))) {
  const lines: Ran = await Bun.file(join(ranDir, take)).json();
  for (const [file, of] of Object.entries(lines)) ran[file] = [...(ran[file] ?? []), ...of];
}

await rm(ranDir, { recursive: true, force: true });

const report = await reportOf(dir, ran);
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

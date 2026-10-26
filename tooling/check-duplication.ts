// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Fails on any block of 8 lines and 60 tokens or more that TypeScript or JavaScript files share,
// or that one file repeats (jscpd, configured in .jscpd.json). A block that must mirror another,
// such as across packages, which share no code (AGENTS.md rule 1), sits between
// jscpd's ignore-start marker, with its reason after a colon, and its ignore-end marker (AGENTS.md
// rule 7).
// Usage: bun tooling/check-duplication.ts

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

interface Place {
  name: string;
  start: number;
  end: number;
}

async function clones(dir: string) {
  const jscpd = join(ROOT, "node_modules/.bin/jscpd");
  const command = [jscpd, "--config", ".jscpd.json", "--reporters", "json", "-o", dir];
  const child = Bun.spawn(command, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const errors = await new Response(child.stderr).text();
  const code = await child.exited;
  if (code !== 0) throw new Error(`jscpd failed:\n${errors}`);
  const report: { duplicates: Array<{ firstFile: Place; secondFile: Place }> } = await Bun.file(
    join(dir, "jscpd-report.json"),
  ).json();
  return report.duplicates;
}

const dir = await mkdtemp(join(tmpdir(), "snowy-duplication-"));

try {
  const found = await clones(dir);
  const at = (p: Place) => `${p.name}:${p.start}-${p.end}`;
  for (const { firstFile, secondFile } of found)
    console.error(`${at(firstFile)} repeats as ${at(secondFile)}`);

  if (found.length > 0) {
    console.error("Share the repeated code (AGENTS.md rule 7).");
    process.exitCode = 1;
  } else {
    console.log("No repeated blocks");
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

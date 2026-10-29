// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Checks what REUSE can't (LICENSE.md, AGENTS.md rule 9): that each of the Snowy Authors' SPDX
// headers names the licence of where its file lives, and that the documentation sections the
// Snowy License's interoperability terms name by title still exist.
// Usage: bun tooling/check-licences.ts

import { join } from "node:path";
import { $ } from "bun";

const ROOT = join(import.meta.dir, "..");
const SNOWY = "LicenseRef-Snowy-License-1.0";
// REUSE-IgnoreStart
const HEADER = /^\W*SPDX-License-Identifier: (\S+)/m;
const OURS = /^\W*SPDX-FileCopyrightText: \d{4} (The Snowy Authors|Pratik Kumar Singh)\b/m;
// REUSE-IgnoreEnd

function expected(file: string) {
  if (file.startsWith("packages/ffmpeg/")) return "LGPL-2.1-or-later";
  if (file.startsWith("packages/")) return SNOWY;
  if (file.startsWith("brand/") && !file.endsWith(".md")) return "LicenseRef-Snowy-Brand";
  return "MIT";
}

// Third-party files keep their own licence, so only headers the project wrote are held to it.
async function headers(files: string[]) {
  const problems: string[] = [];

  for (const file of files) {
    const text = await Bun.file(join(ROOT, file)).text();
    const head = text.split("\n", 6).join("\n");
    const found = HEADER.exec(head)?.[1];
    const want = expected(file);
    if (found !== undefined && OURS.test(head) && found !== want)
      problems.push(`${file}: ${found}, but files there are ${want}`);
  }

  return problems;
}

// Section 8 quotes the titles of the sections that define the open project format.
async function sections() {
  const licence = await Bun.file(join(ROOT, `LICENSES/${SNOWY}.txt`)).text();
  const terms = /^8\. Interoperability\n([\s\S]*?)^9\. /m.exec(licence)?.[1] ?? "";
  const doc = /(packages\/\S+\.md)/.exec(terms)?.[1];
  const titles = [...terms.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
  if (doc === undefined || titles.length === 0)
    return [`${SNOWY}.txt: section 8 names no document and sections`];

  const file = Bun.file(join(ROOT, doc));
  const exists = await file.exists();
  if (!exists) return [`${doc}: missing, which the Snowy License names`];

  const text = await file.text();
  const missing = titles.filter((t) => !new RegExp(`^#+ ${RegExp.escape(t)}$`, "m").test(text));
  return missing.map((t) => `${doc}: no section "${t}", which the Snowy License names`);
}

const listed = await $`git ls-files --format=${"%(objectmode) %(path)"}`.cwd(ROOT).text();
// 120000 is a symbolic link, such as .claude/skills into .agents/skills.
const files = listed
  .split("\n")
  .filter((l) => l !== "" && !l.startsWith("120000 "))
  .map((l) => l.slice(l.indexOf(" ") + 1))
  .filter((f) => !f.startsWith("LICENSES/"));
const [wrong, missing] = await Promise.all([headers(files), sections()]);
const problems = [...wrong, ...missing];

for (const problem of problems) console.error(problem);

if (problems.length > 0) {
  console.error("Give each file the licence of where it lives (LICENSE.md).");
  process.exit(1);
}

console.log(
  `${files.length} files: every SPDX header names its place's licence, and the sections the Snowy License names exist`,
);

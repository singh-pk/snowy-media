// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Audio decode benchmark: demux + decode to float planar of one minute of audio per codec
// (see scripts/gen-bench-media.ts), in Chromium with disk-backed Files. Reports the
// median of --runs fresh workers, as a multiple of real time.
//
// Usage: bun bench/decode.ts [--runs 3]
//          [--out bench/results/name.json]

import { parseArgs } from "node:util";
import { median, openBenchPage, report } from "./page";

const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    out: { type: "string" },
  },
});

interface Run {
  [file: string]: { ms: number; realtime: number; samples: number; channels: number };
}

const result = {
  date: new Date().toISOString(),
  runs: Number(args.runs),
  browsers: {} as Record<string, Record<string, unknown>>,
};

const page = await openBenchPage("audio-*.mka");
const runs: Run[] = [];

for (let i = 0; i < Number(args.runs); i++) {
  const run = await page.run<Run>("/bench/decode.worker.js");
  runs.push(run);
}

const measured: Record<string, unknown> = { version: page.version };

for (const file of Object.keys(runs[0] ?? {})) {
  const all = runs.map((r) => r[file]);
  const first = all[0];

  if (!first || "error" in first) {
    measured[file] = first;
    continue;
  }

  const ms = median(all.map((r) => r?.ms ?? 0));
  measured[file] = { ...first, ms, realtime: median(all.map((r) => r?.realtime ?? 0)) };
  console.error(
    file,
    `${ms.toFixed(0)} ms`,
    `${median(all.map((r) => r?.realtime ?? 0)).toFixed(0)}x`,
  );
}

result.browsers.chromium = measured;
await page.close();
await report(result, args.out);

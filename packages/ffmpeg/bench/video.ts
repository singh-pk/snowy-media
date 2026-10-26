// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Video decode benchmark: demux + decode of 10 seconds of 1080p30 per codec (see
// scripts/gen-bench-media.ts), each frame copied out of the WASM heap, in Chromium with
// disk-backed Files, at each thread count. Reports the median of --runs fresh workers, in
// frames per second.
//
// Usage: bun bench/video.ts [--runs 3] [--threads 1,2,4,8]
//          [--dist dist] [--out bench/results/name.json]

import { parseArgs } from "node:util";
import { median, openBenchPage, report } from "./page";

const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    threads: { type: "string", default: "1,2,4,8" },
    dist: { type: "string", default: "dist" },
    out: { type: "string" },
  },
});

interface Run {
  [file: string]: { ms: number; fps: number; frames: number; width: number; height: number };
}

const result = {
  date: new Date().toISOString(),
  runs: Number(args.runs),
  browsers: {} as Record<string, Record<string, unknown>>,
};

const page = await openBenchPage("video-*.mkv");
const measured: Record<string, Record<string, unknown>> = {};

for (const threads of args.threads.split(",").map(Number)) {
  const runs: Run[] = [];

  for (let i = 0; i < Number(args.runs); i++) {
    const run = await page.run<Run>("/bench/video.worker.js", { threads, dist: `/${args.dist}` });
    runs.push(run);
  }

  for (const file of Object.keys(runs[0] ?? {})) {
    const all = runs.map((r) => r[file]);
    const first = all[0];
    measured[file] ??= {};
    const byThreads = measured[file];

    if (!first || "error" in first) {
      byThreads[threads] = first;
      continue;
    }

    const fps = median(all.map((r) => r?.fps ?? 0));
    byThreads[threads] = { ...first, ms: median(all.map((r) => r?.ms ?? 0)), fps };
    console.error(file, `${threads} threads`, `${fps.toFixed(1)} fps`);
  }
}

result.browsers.chromium = { version: page.version, ...measured };
await page.close();
await report(result, args.out);

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Builds the engine for a page without a bundler into test/dist, its ffmpeg imports pointing
// at /ffmpeg/, and serves the package with the ffmpeg package under /ffmpeg/. A page imports
// the engine from ENTRY. Shared by the tests and the benchmarks.

import { dirname } from "node:path";
import { COVERAGE, wrapWorkers } from "../../../../tooling/coverage";
import { serve } from "../../../../tooling/test-server";
import { build } from "../../scripts/build";

const pkg = new URL("../../", import.meta.url);
const dir = Bun.fileURLToPath(pkg);
const ffmpeg = Bun.pathToFileURL(
  `${dirname(Bun.resolveSync("@snowy-media/ffmpeg/package.json", dir))}/`,
);

export const ENTRY = "/test/dist/index.js";
/** The media worker, for a test that drives it directly. */
export const MEDIA_WORKER = "/test/dist/media.worker.js";
/** The AudioWorklet module. */
export const AUDIO_WORKLET = "/test/dist/audio.worklet.js";
/** test/support/track.ts. */
export const TRACK_PAGE = "/test/dist/test/support/track.js";
/** test/support/page.ts. */
export const PAGE = "/test/dist/test/support/page.js";
/** bench/ring.worker.ts. */
export const RING_WORKER = "/test/dist/bench/ring.worker.js";

async function buildAll() {
  const outdir = `${dir}test/dist/`;
  await build({ outdir, ffmpeg: "/ffmpeg/", sourcemap: "external" });
  await build({
    outdir,
    ffmpeg: "/ffmpeg/",
    entrypoints: ["test/support/page.ts", "test/support/track.ts", "bench/ring.worker.ts"],
    sourcemap: "external",
  });
  const workers = [
    "media.worker.js",
    "render.worker.js",
    "video.worker.js",
    "bench/ring.worker.js",
  ];
  if (COVERAGE) await wrapWorkers(workers.map((f) => outdir + f));
}

// Once, however many servers a test starts.
const built = buildAll();

export async function serveEngine(page: string, { isolated = true } = {}) {
  await built;
  return serve(pkg, page, { isolated, mounts: { "/ffmpeg/": ffmpeg } });
}

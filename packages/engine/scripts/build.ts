// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Bundles the engine and each of its workers for browsers. Workers are entry points of their
// own, loaded by URL (src/index.ts), so each thread loads only its own code.
//
// @snowy-media/ffmpeg stays an import, so the app's bundler resolves it together with the
// WebAssembly files it loads by URL. A page served without a bundler (the tests) passes
// `ffmpeg`, the URL path the ffmpeg package is served under, and the imports point there.
//
// Bundling drops the source files' SPDX headers, so each bundle carries the licence as a
// legal comment, which minifiers keep.

import { $, Glob } from "bun";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";

const pkg = Bun.fileURLToPath(new URL("../", import.meta.url));
// REUSE-IgnoreStart
const LICENSE_NOTICE =
  "/*! @snowy-media/engine | SPDX-License-Identifier: LicenseRef-Snowy-License-1.0 | " +
  "https://github.com/singh-pk/snowy-media/blob/main/LICENSES/LicenseRef-Snowy-License-1.0.txt */";
// REUSE-IgnoreEnd

interface Options {
  /** Where the bundles go. */
  outdir: string;
  /** The URL path the ffmpeg package is served under, instead of leaving it to a bundler. */
  ffmpeg?: string;
  /** Other entry points, relative to the package, in place of the engine's; each keeps its path. */
  entrypoints?: string[];
  /** Source maps beside the bundles, for the tests' coverage (tooling/coverage.ts). */
  sourcemap?: "external";
}

// Points each @snowy-media/ffmpeg import at its file under the URL path `prefix`.
function ffmpegAt(prefix: string): Bun.BunPlugin {
  const root = `${dirname(Bun.resolveSync("@snowy-media/ffmpeg/package.json", pkg))}/`;

  return {
    name: "ffmpeg-url",
    setup(b) {
      b.onResolve({ filter: /^@snowy-media\/ffmpeg\// }, (args) => ({
        path: prefix + Bun.resolveSync(args.path, args.importer).slice(root.length),
        external: true,
      }));
    },
  };
}

export async function build({ outdir, ffmpeg, entrypoints, sourcemap }: Options) {
  await Bun.build({
    entrypoints: entrypoints
      ? entrypoints.map((f) => pkg + f)
      : [
          "index.ts",
          "media.worker.ts",
          "render.worker.ts",
          "video.worker.ts",
          "audio.worklet.ts",
        ].map((f) => `${pkg}src/${f}`),
    root: entrypoints ? pkg : `${pkg}src/`,
    outdir,
    target: "browser",
    format: "esm",
    packages: "external",
    plugins: ffmpeg ? [ffmpegAt(ffmpeg)] : [],
    banner: LICENSE_NOTICE,
    sourcemap: sourcemap ?? "none",
  });
}

// The package: dist/ emptied, so it holds only this build, then the bundles and the
// declarations of the public API (tsconfig.dts.json). tsc keeps their relative imports as
// written, without an extension, which a consumer resolving as Node does ("node16") cannot
// follow, so they get the .js the bundles have.
async function buildPackage() {
  const outdir = `${pkg}dist/`;
  await rm(outdir, { recursive: true, force: true });
  await build({ outdir });
  await $`bun --bun tsc -p ${pkg}tsconfig.dts.json`;

  for (const file of new Glob("*.d.ts").scanSync(outdir)) {
    const text = await Bun.file(outdir + file).text();
    await Bun.write(outdir + file, text.replaceAll(/(from "\.\/[\w.-]+)"/g, '$1.js"'));
  }
}

if (import.meta.main) await buildPackage();

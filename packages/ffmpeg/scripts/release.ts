// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Prepares the release for tag @snowy-media/ffmpeg@X.Y.Z (.github/workflows/release.yml): the
// shared steps of tooling/release.ts, with the LGPL as LICENSE. Writes into release/
//   notes.md                                the CHANGELOG.md section
//   snowy-media-ffmpeg-X.Y.Z.tgz            the npm package, checked to hold exactly the
//                                           files below, which npm then publishes as is
//   snowy-media-ffmpeg-X.Y.Z-source.tar.xz  this package at HEAD plus, in third_party/, the
//                                           FFmpeg, dav1d, zlib and bzip2 sources the modules are
//                                           built from: the source the LGPL requires (NOTICE)
// Usage: bun scripts/release.ts @snowy-media/ffmpeg@X.Y.Z (needs Docker with buildx)

import { $ } from "bun";
import { mkdir, rm } from "node:fs/promises";
import { packRelease, startRelease } from "../../../tooling/release";

const release = await startRelease({
  root: Bun.fileURLToPath(new URL("../", import.meta.url)),
  tag: process.argv[2] ?? "",
  licence: "LGPL-2.1-or-later",
});
const { root, out, name } = release;
const stage = `${out}${name}/`;
await mkdir(`${stage}third_party`, { recursive: true });
await Bun.write(`${stage}LICENSE`, Bun.file(`${root}LICENSE`));

const pkg = await Bun.file(`${root}package.json`).json();
const modules = Object.keys(pkg.exports)
  .filter((key) => key !== "./package.json")
  .map((key) => key.slice(2));
await packRelease(release, [
  "package.json",
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  ...[
    "bzip2/LICENSE",
    "dav1d/COPYING",
    "ffmpeg/COPYING.LGPLv2.1",
    "ffmpeg/LICENSE.md",
    "zlib/LICENSE",
  ].map((file) => `dist/licenses/${file}`),
  ...modules.flatMap((m) =>
    [`${m}.js`, `${m}.wasm`, "index.js", "index.d.ts"].map((f) => `dist/${m}/${f}`),
  ),
]);

await $`git -C ${root} archive HEAD | tar -xf - -C ${stage}`;
await $`docker buildx build --target source --output type=local,dest=${stage}third_party ${root}`;
await $`tar -cJf ${out}${name}-source.tar.xz -C ${out} ${name}`;
await rm(stage, { recursive: true });
console.log(`release/${name}.tgz\nrelease/${name}-source.tar.xz`);

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Prepares the release for tag @snowy-media/ffmpeg@X.Y.Z (.github/workflows/release.yml):
// checks that the tag matches package.json and has a CHANGELOG.md section, copies the LGPL
// text into LICENSE, and writes into release/
//   notes.md                                that section
//   snowy-media-ffmpeg-X.Y.Z.tgz            the npm package, checked to hold exactly the
//                                           files below, which npm then publishes as is
//   snowy-media-ffmpeg-X.Y.Z-source.tar.xz  this package at HEAD plus, in third_party/, the
//                                           FFmpeg, dav1d, zlib and bzip2 sources the modules are
//                                           built from: the source the LGPL requires (NOTICE)
// Usage: bun scripts/release.ts @snowy-media/ffmpeg@X.Y.Z (needs Docker with buildx)

import { $ } from "bun";
import { mkdir, rm } from "node:fs/promises";

// jscpd:ignore-start: mirrors packages/engine/scripts/release.ts, since packages share no code
const tag = process.argv[2] ?? "";
const root = new URL("../", import.meta.url).pathname;
const pkg = await Bun.file(`${root}package.json`).json();
const { version } = pkg;
if (tag !== `${pkg.name}@${version}`) throw new Error(`tag "${tag}" is not ${pkg.name}@${version}`);

const changelog = await Bun.file(`${root}CHANGELOG.md`).text();
const section = changelog.split(/^## /m).find((s) => s.startsWith(`[${version}]`));
if (!section) throw new Error(`CHANGELOG.md has no [${version}] section`);
// jscpd:ignore-end

const out = `${root}release/`;
const name = `snowy-media-ffmpeg-${version}`;
const stage = `${out}${name}/`;
await rm(out, { recursive: true, force: true });
await mkdir(`${stage}third_party`, { recursive: true });
await Bun.write(`${out}notes.md`, `${section.slice(section.indexOf("\n") + 1).trim()}\n`);

const license = Bun.file(`${root}../../LICENSES/LGPL-2.1-or-later.txt`);
await Bun.write(`${root}LICENSE`, license);
await Bun.write(`${stage}LICENSE`, license);

// A wrong `files` pattern or a missing build step would otherwise publish an incomplete
// package that npm never lets us replace.
const modules = Object.keys(pkg.exports)
  .filter((key) => key !== "./package.json")
  .map((key) => key.slice(2));
const expected = [
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
].toSorted();
// jscpd:ignore-start: mirrors packages/engine/scripts/release.ts, since packages share no code
await $`bun pm pack --quiet --destination ${out}`.cwd(root);
const listing = await $`tar -tzf ${out}${name}.tgz`.text();
const packed = listing
  .trim()
  .split("\n")
  .map((path) => path.replace(/^package\//, ""))
  .toSorted();

if (packed.join("\n") !== expected.join("\n")) {
  throw new Error(
    `the npm package holds\n${packed.join("\n")}\nbut should hold\n${expected.join("\n")}`,
  );
}
// jscpd:ignore-end

await $`git -C ${root} archive HEAD | tar -xf - -C ${stage}`;
await $`docker buildx build --target source --output type=local,dest=${stage}third_party ${root}`;
await $`tar -cJf ${out}${name}-source.tar.xz -C ${out} ${name}`;
await rm(stage, { recursive: true });
console.log(`release/${name}.tgz\nrelease/${name}-source.tar.xz`);

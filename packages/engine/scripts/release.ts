// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Prepares the release for tag @snowy-media/engine@X.Y.Z (.github/workflows/release.yml), from
// a build (bun run build): checks that the tag matches package.json and has a CHANGELOG.md
// section, and that the @snowy-media/ffmpeg in the repository is released, copies the Snowy
// License text into LICENSE, and writes into release/
//   notes.md                         that section
//   snowy-media-engine-X.Y.Z.tgz     the npm package, checked to hold exactly the files below
//                                    and to depend on that @snowy-media/ffmpeg, which npm
//                                    then publishes as is
// Usage: bun scripts/release.ts @snowy-media/engine@X.Y.Z

import { $, Glob } from "bun";
import { rm } from "node:fs/promises";

// jscpd:ignore-start: mirrors packages/ffmpeg/scripts/release.ts, since packages share no code
const tag = process.argv[2] ?? "";
const root = Bun.fileURLToPath(new URL("../", import.meta.url));
const pkg = await Bun.file(`${root}package.json`).json();
const { version } = pkg;
if (tag !== `${pkg.name}@${version}`) throw new Error(`tag "${tag}" is not ${pkg.name}@${version}`);

const changelog = await Bun.file(`${root}CHANGELOG.md`).text();
const section = changelog.split(/^## /m).find((s) => s.startsWith(`[${version}]`));
if (!section) throw new Error(`CHANGELOG.md has no [${version}] section`);
// jscpd:ignore-end

// The engine was tested against @snowy-media/ffmpeg as it is in the repository, so that must
// be what npm has: its version released, with nothing unreleased in its changelog. Packing
// replaces `workspace:^` with that version.
const ffmpegDir = `${root}../ffmpeg/`;
const { version: ffmpeg } = await Bun.file(`${ffmpegDir}package.json`).json();
const ffmpegLog = await Bun.file(`${ffmpegDir}CHANGELOG.md`).text();
// Up to the next version, or the links when none is released.
const unreleased = /^## \[Unreleased\]\n(?<body>[\s\S]*?)^(?:## |\[Unreleased\]:)/m.exec(ffmpegLog);

if (unreleased?.groups?.body?.trim() !== "") {
  throw new Error("release @snowy-media/ffmpeg first: it has unreleased changes");
}

const registry = await fetch(`https://registry.npmjs.org/@snowy-media/ffmpeg/${ffmpeg}`);
if (!registry.ok) throw new Error(`@snowy-media/ffmpeg@${ffmpeg} is not on npm`);

const out = `${root}release/`;
const name = `snowy-media-engine-${version}`;
await rm(out, { recursive: true, force: true });
await Bun.write(`${out}notes.md`, `${section.slice(section.indexOf("\n") + 1).trim()}\n`);
await Bun.write(
  `${root}LICENSE`,
  Bun.file(`${root}../../LICENSES/LicenseRef-Snowy-License-1.0.txt`),
);

// A wrong `files` pattern or a missing build step would otherwise publish an incomplete
// package that npm never lets us replace. The declarations are what tsc emitted into dist/,
// which the build empties first.
const declarations = [...new Glob("dist/*.d.ts").scanSync(root)];
const expected = [
  "package.json",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  ...["index", "media.worker", "render.worker", "video.worker", "audio.worklet"].map(
    (f) => `dist/${f}.js`,
  ),
  ...declarations,
].toSorted();
if (!declarations.includes("dist/index.d.ts")) throw new Error("dist/index.d.ts is missing");
await $`bun pm pack --quiet --destination ${out}`.cwd(root);
const tarball = `${out}${name}.tgz`;
// jscpd:ignore-start: mirrors packages/ffmpeg/scripts/release.ts, since packages share no code
const listing = await $`tar -tzf ${tarball}`.text();
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

const packedJson = await $`tar -xzOf ${tarball} package/package.json`.text();
const manifest = JSON.parse(packedJson);

if (manifest.dependencies?.["@snowy-media/ffmpeg"] !== `^${ffmpeg}`) {
  throw new Error(`the package does not depend on @snowy-media/ffmpeg ^${ffmpeg}`);
}

console.log(`release/${name}.tgz`);

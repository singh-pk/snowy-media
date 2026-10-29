// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Prepares the release for tag @snowy-media/engine@X.Y.Z (.github/workflows/release.yml), from
// a build (bun run build): the shared steps of tooling/release.ts, with the Snowy License as
// LICENSE, and a check that the @snowy-media/ffmpeg in the repository is released. Writes into
// release/
//   notes.md                         the CHANGELOG.md section
//   snowy-media-engine-X.Y.Z.tgz     the npm package, checked to hold exactly the files below
//                                    and to depend on that @snowy-media/ffmpeg, which npm
//                                    then publishes as is
// Usage: bun scripts/release.ts @snowy-media/engine@X.Y.Z

import { $, Glob } from "bun";
import { packRelease, startRelease } from "../../../tooling/release";

const root = Bun.fileURLToPath(new URL("../", import.meta.url));

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

const release = await startRelease({
  root,
  tag: process.argv[2] ?? "",
  licence: "LicenseRef-Snowy-License-1.0",
});

// The declarations are what tsc emitted into dist/, which the build empties first.
const declarations = [...new Glob("dist/*.d.ts").scanSync(root)];
if (!declarations.includes("dist/index.d.ts")) throw new Error("dist/index.d.ts is missing");
const tarball = await packRelease(release, [
  "package.json",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  ...["index", "media.worker", "render.worker", "video.worker", "audio.worklet"].map(
    (f) => `dist/${f}.js`,
  ),
  ...declarations,
]);

const packedJson = await $`tar -xzOf ${tarball} package/package.json`.text();
const manifest = JSON.parse(packedJson);

if (manifest.dependencies?.["@snowy-media/ffmpeg"] !== `^${ffmpeg}`) {
  throw new Error(`the package does not depend on @snowy-media/ffmpeg ^${ffmpeg}`);
}

console.log(`release/${release.name}.tgz`);

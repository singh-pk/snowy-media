// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The steps every package's scripts/release.ts shares (CONTRIBUTING.md#releasing): the tag and
// changelog checks, the release notes, LICENSE from LICENSES/, and the packed npm tarball.

import { join } from "node:path";
import { rm } from "node:fs/promises";
import { $ } from "bun";

const LICENSES = join(import.meta.dir, "..", "LICENSES");

export interface Release {
  /** The package directory, ending in `/`. */
  root: string;
  /** `snowy-media-<name>-<version>`, as `bun pm pack` names the tarball. */
  name: string;
  /** `<root>release/`, emptied. */
  out: string;
}

/**
 * Starts the release of the package at `root` for `tag`: throws unless the tag is
 * `<name>@<version>` from package.json and CHANGELOG.md has a section for that version, then
 * writes the section to release/notes.md and the text of `licence`, an SPDX identifier in
 * LICENSES/, to the package's LICENSE.
 */
export async function startRelease(options: { root: string; tag: string; licence: string }) {
  const { root, tag, licence } = options;
  const pkg = await Bun.file(`${root}package.json`).json();
  const { version } = pkg;
  if (tag !== `${pkg.name}@${version}`)
    throw new Error(`tag "${tag}" is not ${pkg.name}@${version}`);

  const changelog = await Bun.file(`${root}CHANGELOG.md`).text();
  const section = changelog.split(/^## /m).find((s) => s.startsWith(`[${version}]`));
  if (!section) throw new Error(`CHANGELOG.md has no [${version}] section`);

  const out = `${root}release/`;
  await rm(out, { recursive: true, force: true });
  await Bun.write(`${out}notes.md`, `${section.slice(section.indexOf("\n") + 1).trim()}\n`);
  await Bun.write(`${root}LICENSE`, Bun.file(join(LICENSES, `${licence}.txt`)));
  const name = `${pkg.name.slice(1).replace("/", "-")}-${version}`;
  return { root, name, out } satisfies Release;
}

/**
 * Packs the package into release/ and returns the tarball's path. Throws unless it holds exactly
 * `expected`, paths relative to the package: npm never lets a published version be replaced.
 */
export async function packRelease(release: Release, expected: string[]) {
  const { root, out, name } = release;
  await $`bun pm pack --quiet --destination ${out}`.cwd(root);
  const tarball = `${out}${name}.tgz`;
  const listing = await $`tar -tzf ${tarball}`.text();
  const packed = listing
    .trim()
    .split("\n")
    .map((path) => path.replace(/^package\//, ""))
    .toSorted();
  const want = expected.toSorted();

  if (packed.join("\n") !== want.join("\n")) {
    throw new Error(
      `the npm package holds\n${packed.join("\n")}\nbut should hold\n${want.join("\n")}`,
    );
  }

  return tarball;
}

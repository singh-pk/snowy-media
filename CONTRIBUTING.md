# Contributing

Thanks for helping. This guide is for people and AI agents alike; agents also read [AGENTS.md](AGENTS.md).

## Ways to help

- **A file that won't open, or opens wrong:** use the [format issue form](https://github.com/singh-pk/snowy-media/issues/new?template=format.yml). A small sample file is the most useful thing you can attach.
- **A bug in the build, API or tooling:** use the [bug form](https://github.com/singh-pk/snowy-media/issues/new?template=bug.yml).
- **An idea:** open a [feature request](https://github.com/singh-pk/snowy-media/issues/new?template=feature.yml) before writing code, so we can agree on the shape first.
- **A question:** ask in [Discussions](https://github.com/singh-pk/snowy-media/discussions).
- **A security problem:** never in a public issue. See [SECURITY.md](SECURITY.md).

## Set up

You need [Bun](https://bun.sh) (the version in the root `package.json`), and Docker with buildx to build `packages/ffmpeg`. Everything runs on Bun; there is no Node.js or Python tooling.

```sh
bun install                 # every package's dependencies; also enables the pre-commit hook
bun run build               # every package; FFmpeg's first build takes a while
bunx playwright install chromium  # the browser for the tests, once
bun test                    # every package, in Chromium
```

Each package lives in `packages/<name>` with its own README, `docs/`, CHANGELOG and, where it has more rules, AGENTS.md. Inside a package, `bun run build`, `bun test` and its other scripts work on that package alone.

The repository checks in CI also run locally if you install the tools (`brew install actionlint shellcheck shfmt hadolint typos-cli zizmor`):

```sh
actionlint && zizmor --offline .github && shellcheck packages/ffmpeg/build/*.sh .githooks/* \
  && shfmt --diff packages/ffmpeg/build .githooks && typos \
  && hadolint --config packages/ffmpeg/.hadolint.yaml packages/ffmpeg/Dockerfile
```

## Make the change

- **Keep it small.** One concern, and normally one package, per pull request. A focused 50-line PR is reviewed the same day; a 1,000-line one waits.
- **Follow the package's rules** in its AGENTS.md and `docs/`. For FFmpeg that means the boundary in [packages/ffmpeg/docs/architecture.md](packages/ffmpeg/docs/architecture.md): JavaScript reads FFmpeg data only through getters in `src/*.c`, never by offset.
- **Keep packages headless.** No CSS, UI frameworks, telemetry or product policy such as accounts and usage limits in a package; Snowy's apps own those ([AGENTS.md](AGENTS.md) rule 10).
- **Prove it.** A behaviour change comes with a test. An FFmpeg demuxing fix adds a fixture to `packages/ffmpeg/scripts/gen-fixtures.ts`, so its expectation comes from native `ffprobe`. A performance change shows benchmark numbers before and after.
- **Format and lint** with `bun run format` and `bun run check`. The pre-commit hook runs the same check as CI. Besides oxlint's own rules, [`tooling/oxlint-rules`](tooling/oxlint-rules) enforces a few house rules; AGENTS.md lists them.
- **Update the package's CHANGELOG.md** under *Unreleased* for anything a user would notice. CI requires an entry for `feat`, `fix` and `perf` pull requests; a maintainer adds the `no-changelog` label when nobody outside the repository would notice.

### Updating a pinned FFmpeg dependency

FFmpeg, Emscripten, dav1d, zlib and bzip2 are pinned in [packages/ffmpeg/Dockerfile](packages/ffmpeg/Dockerfile) by version and sha256 (FFmpeg also by signing key; Emscripten by image digest). To bump one, change the version and checksum together, rebuild, run the tests and the benchmark, and update `dist.sha256` in `packages/ffmpeg` with `shasum -a 256 dist/{core/core,audio-ext/audio-ext,video/video,video-ext/video-ext}.{js,wasm} > dist.sha256`. The `ffmpeg-update-dependency` skill in `.agents/skills` walks through it.

## Commits and pull requests

Pull requests are squash-merged, and the title becomes the commit on `main`, so it must be a [Conventional Commit](https://www.conventionalcommits.org): `type(scope): summary` in lowercase imperative, for example `fix(core): keep pts when seeking raw H.264`. Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`, `revert`. CI checks the title. Dependabot's titles start with a capital `Bump`, which it cannot be set to lower, so CI allows that one word from it.

Fill in the pull request template. Every pull request needs green CI and a review from a code owner.

### AI-assisted contributions

Welcome, on the same terms as any other: you are responsible for every line, and you must understand and be able to explain it. Say in the pull request which parts an agent wrote. The repository ships agent instructions ([AGENTS.md](AGENTS.md)), task skills (`.agents/skills`) and a reviewer agent (`.claude/agents/code-reviewer.md`) so agents follow the same rules people do.

## Releasing

Maintainers release a package from `main`, in a pull request and then a tag. For `@snowy-media/<name>`, here `ffmpeg` or `engine`:

1. In a pull request titled `chore(release): release @snowy-media/<name> X.Y.Z` (the summary must start with a lowercase letter), set `version` in `packages/<name>/package.json` and rename `## [Unreleased]` in `packages/<name>/CHANGELOG.md` to `## [X.Y.Z] - date`, with a new empty `## [Unreleased]` above it and the links at the bottom updated. Merge it.
2. Tag the merge commit with the package name and version, and push the tag: `git tag @snowy-media/<name>@X.Y.Z && git push origin @snowy-media/<name>@X.Y.Z`. Only admins can create, move or delete `@snowy-media/*` tags.

[`release.yml`](.github/workflows/release.yml) then:

1. checks that the tag is on `main`;
2. for ffmpeg, rebuilds the modules without a cache and checks them against `dist.sha256`; for the engine, builds it;
3. packs the npm tarball and checks it holds exactly the files it should (the package's `scripts/release.ts`: [ffmpeg](packages/ffmpeg/scripts/release.ts), [engine](packages/engine/scripts/release.ts), on the shared steps of [`tooling/release.ts`](tooling/release.ts), which also copies the package's licence from `LICENSES/` into `LICENSE`). The engine's also checks that `@snowy-media/ffmpeg` as it is in the repository, which the engine was tested against, is released: release ffmpeg first when it has unreleased changes;
4. creates a draft GitHub release with the changelog section and the tarball, plus for ffmpeg the source archive;
5. publishes that tarball to npm with provenance through [trusted publishing](https://docs.npmjs.com/trusted-publishers), so no npm token exists anywhere;
6. publishes the GitHub release. Releases are immutable once published, which is why this comes last.

If a run fails, nothing has reached npm and the GitHub release is still a draft: fix the cause, delete the draft, and re-run the workflow. If the fix changes the repository, merge it and move the tag to the new commit on `main` instead.

### The first release of a new package

npm only lets a package that already exists trust a workflow, so a new package starts with a placeholder. The maintainer, signed in with `npm login`:

1. Publishes a placeholder holding only `package.json` (name, version `0.0.0`, licence, repository with `directory`) and a short README, in a new directory of its own: the package's own would pack its build, and its `publishConfig` asks for provenance, which npm generates only in CI. There, `npm stage publish --access public`, then `npm stage approve <id>` with 2FA.
2. Creates the trusted publisher: `npm trust github @snowy-media/<name> --file release.yml --repo singh-pk/snowy-media --allow-publish`. Without `--allow-publish`, npm accepts only staged publishes from CI. Check it with `npm trust list @snowy-media/<name>`.
3. Under the package's settings on npmjs.com, sets publishing access to "Require two-factor authentication and disallow bypass 2fa tokens".
4. Pushes the first real release tag within 48 hours of step 2, as above, once `release.yml` has a job for the package.
5. Deprecates the placeholders: `npm deprecate "@snowy-media/<name>@0.0.0 || 0.0.0-stage" "Placeholder; install X.Y.Z or later"`.

## Licensing

[LICENSE.md](LICENSE.md) says which licence covers which files: the packages are under the [Snowy License 1.0](LICENSES/LicenseRef-Snowy-License-1.0.txt), except `packages/ffmpeg`, which is [LGPL-2.1-or-later](LICENSES/LGPL-2.1-or-later.txt) like FFmpeg; the repository tooling is [MIT](LICENSES/MIT.txt); and the name and logos are trademarks ([TRADEMARKS.md](TRADEMARKS.md)).

### The Contributor License Agreement

Before your first pull request is merged, you sign the [Contributor License Agreement](CLA.md). You keep the copyright in your work; the agreement lets the maintainer license it under any terms, including the licence of the files it changes and company licences, which is how Snowy is funded. To sign, add a line with your GitHub account's numeric ID and login to [`.github/cla-signatures.txt`](.github/cla-signatures.txt) in your first pull request, as the file describes. CI checks that you and every commit author have signed; anyone you credit as a co-author must have signed too. One signature covers all your contributions.

### SPDX headers

Every new source file starts with SPDX headers naming the licence of where it lives, for example in `packages/timeline`:

<!-- REUSE-IgnoreStart -->

```ts
// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
```

<!-- REUSE-IgnoreEnd -->

Use `LGPL-2.1-or-later` in `packages/ffmpeg` and `MIT` for tooling. Code from elsewhere keeps its own copyright and licence in its headers, and is listed in the package's NOTICE. CI runs [REUSE](https://reuse.software) to check every file, and `bun run lint:licences` checks that each header names the licence of where its file lives.

## Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

# Agent guide

Instructions for AI coding agents working in this repository. People should read [CONTRIBUTING.md](CONTRIBUTING.md); everything here applies to them too.

Snowy is a frontend-only media toolkit for the browser: a video player first, an editor later. This repository holds its npm packages under `@snowy-media/`, one per directory in `packages/`. Before working in a package, read its own `AGENTS.md` (if it has one) and `docs/`; they add rules to the ones here.

## Packages

| Package | Directory | Licence | What it is |
| --- | --- | --- | --- |
| `@snowy-media/engine` | [`packages/engine`](packages/engine) | Snowy License 1.0 | The playback pipeline, without a user interface ([AGENTS.md](packages/engine/AGENTS.md)) |
| `@snowy-media/ffmpeg` | [`packages/ffmpeg`](packages/ffmpeg) | LGPL-2.1-or-later | FFmpeg 9 compiled to WebAssembly modules ([AGENTS.md](packages/ffmpeg/AGENTS.md)) |
| `@snowy-media/sync` | [`packages/sync`](packages/sync) | Snowy License 1.0 | Watch-together sessions: streaming, chat and playback sync ([AGENTS.md](packages/sync/AGENTS.md)) |
| `@snowy-media/timeline` | [`packages/timeline`](packages/timeline) | Snowy License 1.0 | The edit document: a magnetic timeline, its operations and its linear history ([AGENTS.md](packages/timeline/AGENTS.md)) |

## Commands

Run from the root for every package, or inside `packages/<name>` for one.

| Task | Command |
| --- | --- |
| Install tools, every package's dependencies and the pre-commit hook | `bun install` |
| Build | `bun run build` |
| Browser tests (Chromium) | `bun test` |
| Format everything (root only) | `bun run format` |
| All static checks, CI's `check` job (root only) | `bun run check` |

Run `bun run check` before every commit; the hook runs it anyway.

## Repository map

| Path | What it holds |
| --- | --- |
| `packages/<name>/` | one npm package: its code, tests, README, `docs/`, CHANGELOG and package-specific AGENTS.md |
| `tooling/oxlint-rules/` | repository lint rules (see rule 7) |
| `tooling/test-server.ts`, `tooling/run-unit.ts`, `tooling/unit.ts`, `tooling/unit-worker.ts` | serving a package to Chromium for its tests and benchmarks, and running unit tests there (rule 2) |
| `scripts/` | repository scripts, such as `settings.ts`, which applies `.github/settings.yml` |
| `.agents/skills/` | task playbooks, also linked into `.claude/skills` |
| `brand/` | the logo, avatar and social preview, and the rules for using them; trademarks, not licensed ([TRADEMARKS.md](TRADEMARKS.md)) |
| `LICENSE.md`, `LICENSES/` | which licence covers which files, and the licence texts that SPDX headers refer to ([REUSE](https://reuse.software)) |
| `CLA.md`, `.github/cla-signatures.txt` | the Contributor License Agreement every contributor signs, and who has signed it |

Shared configuration lives once, at the root: `tsconfig.base.json`, `.oxlintrc.json`, `.oxfmtrc.json`, `knip.json`, `_typos.toml`, `.markdownlint-cli2.jsonc`, `REUSE.toml`. Packages extend it; never copy it into a package.

## Rules

1. **Packages are isolated.** A package uses another only through its published name and public exports (`@snowy-media/<name>`), never by relative path into another package. Each package builds, tests and documents itself.
2. **Desktop Chromium only.** Snowy runs in current stable Chromium on desktop (Chrome, Edge), because it opens files only through the File System Access API (rule 3), which Firefox, Safari and Chromium on Android lack. Packages are built, tested, benchmarked and documented for Chromium alone: no code, test, benchmark, CI job or document carries a branch, allowance, workaround or note for another browser engine. Every test runs its code in Chromium, in the build the pinned Playwright version installs (`bunx playwright install chromium`), never in a system browser or a channel and never in Bun: Bun only builds, serves and drives the browser. A test that needs no page is a unit test, `test/**/*.unit.ts`, which `tooling/run-unit.ts` runs in a module worker of a Chromium page, through the package's `test/unit.test.ts`; it imports `test` and `expect` from `tooling/unit.ts`, not `bun:test`, and lint keeps code under test out of a `*.test.ts` file.
3. **Files are persisted handles.** A file the user opens is a `FileSystemFileHandle`, from `showOpenFilePicker` or a dropped item's `getAsFileSystemHandle`, which an app keeps in IndexedDB to open again on a later visit. A public API that opens a user's file takes that handle, never a `File`, `Blob`, URL or `<input type="file">`.
4. **No fallbacks.** One platform baseline (cross-origin isolation, WebAssembly SIMD and threads, WebCodecs, WebGPU, AudioWorklet, File System Access) and one code path. Do not add feature detection, browser-specific branches or main-thread variants.
5. **Performance is measured.** Never claim a speed-up you have not measured; include before and after numbers from the same machine.
6. **Bun and TypeScript only.** Tooling is TypeScript run by Bun. No Node.js or Python scripts; shell only inside Docker builds.
7. **Small, focused diffs.** Change only what the task needs, normally in one package. Match the surrounding style: short functions, comments that explain *why*, SPDX headers on new files (rule 9). `bun run lint` also enforces the house rules: no classes, no module-level `let` (keep state in a `createX()` factory), `await` into a `const` instead of nesting it or chaining `.then`, no `setInterval`, no other timer in a package's `src/` (`setTimeout`, `requestIdleCallback`, `AbortSignal.timeout`, a timed `Atomics.wait`; wait on the event instead), no plan in a comment (`TODO`, `for now`, `next PR`), and a blank line around every multi-line block.
8. **No internal notes in the repository.** No plans, roadmaps, TODO lists, meeting notes or agent scratch files. Rationale for the current design goes in the package's `docs/`; user-visible changes go in its `CHANGELOG.md` under *Unreleased*.
9. **Licences have boundaries.** Every file carries the licence of where it lives ([LICENSE.md](LICENSE.md)): `LicenseRef-Snowy-License-1.0` in every package except `packages/ffmpeg`, new packages included; `LGPL-2.1-or-later` in `packages/ffmpeg`; `MIT` for tooling, configuration and root documents. A new package sets `"license": "SEE LICENSE IN LICENSE"` and its release copies the licence text into `LICENSE`. Never move code across a boundary, such as Snowy-licensed code into tooling or FFmpeg's C into another package. Third-party code keeps its own licence and SPDX header and is listed in the package's NOTICE. Changing a licence, `LICENSE.md`, `TRADEMARKS.md` or `CLA.md` is the maintainer's decision, never an agent's.
10. **Packages are headless.** A package is framework-agnostic and unstyled: no CSS, no UI framework or component library, and nothing it adds to the DOM; it draws only into what the app hands it, such as a canvas. It carries no product policy either: no telemetry or analytics, no accounts, billing or usage limits, and no call to a service Snowy runs. Those belong to Snowy's apps and their server. Where an app needs a say, the package takes a neutral extension point, such as a callback, that knows nothing of the app's policy and allows everything when the app passes none. A package never limits quality: no cap on resolution, bitrate, frame rate, length or exports, and no watermark.
11. **Tests are honest.** An expected value comes from a source independent of the code under test, never from that code. A tolerance is the measured spread of the setup it applies to, with its reason in a comment, and is never widened so that one runner passes. A test that could see nothing asserts how much it saw, such as a minimum number of reads, so it cannot pass vacuously. A test waits on an event, never a sleep.

## Before you open a pull request

1. `bun run check` and `bun test` pass, plus any extra check the package's AGENTS.md asks for.
2. Review your own diff with the `code-reviewer` agent (`.claude/agents/code-reviewer.md`) in a fresh context, and fix what it finds.
3. Title the pull request as a Conventional Commit, fill in the template, and say which parts an agent wrote.

## Skills

Task playbooks in [`.agents/skills`](.agents/skills) (also linked into `.claude/skills`). Skills for one package are prefixed with its name and listed in its AGENTS.md.

| Skill | Use it to |
| --- | --- |
| `triage-issue` | label a new issue and ask for what is missing |

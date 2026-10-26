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
| Line coverage of the unit tests, held to the package's `coverage-floor.json` | `SNOWY_COVERAGE=1 bun test` in the package, then `bun tooling/check-coverage.ts <name>` from the root |

Run `bun run check` before every commit; the hook runs it anyway.

## Repository map

| Path | What it holds |
| --- | --- |
| `packages/<name>/` | one npm package: its code, tests, README, `docs/`, CHANGELOG and package-specific AGENTS.md |
| `tooling/oxlint-rules/` | repository lint rules (see rule 7), each with a `bad.ts` and `good.ts` in `fixtures/` that `tooling/check-lint-rules.ts` checks |
| `tooling/check-structure.ts` | that each package's AGENTS.md Map has a row for every `src/` file and names only paths that exist, and that its README is short, has a diagram and ends with its licence |
| `tooling/markdownlint-rules/` | markdown lint rules, such as `no-slop` (plain prose) |
| `tooling/check-duplication.ts` | the check that no block of code is repeated (rule 7) |
| `tooling/test-server.ts`, `tooling/run-unit.ts`, `tooling/unit.ts`, `tooling/unit-worker.ts` | serving a package to Chromium for its tests and benchmarks, and running unit tests there (rule 2) |
| `tooling/coverage.ts`, `tooling/check-coverage.ts` | line coverage of `src/` from the unit tests' workers, and the per-file floors it may not fall below (rule 11) |
| `tooling/oxlint-dist.json` | the lint CI runs on FFmpeg's built modules: no `eval`, `new Function` or `javascript:` URL in what Emscripten emits (rule 7) |
| `tooling/lint-edited.ts` | the Claude Code hook that lints and format-checks each file an agent edits (`.claude/settings.json`) |
| `scripts/` | repository scripts, such as `settings.ts`, which applies `.github/settings.yml` |
| `.agents/skills/` | task playbooks, also linked into `.claude/skills` |
| `brand/` | the logo, avatar and social preview, and the rules for using them; trademarks, not licensed ([TRADEMARKS.md](TRADEMARKS.md)) |
| `LICENSE.md`, `LICENSES/` | which licence covers which files, and the licence texts that SPDX headers refer to ([REUSE](https://reuse.software)) |
| `CLA.md`, `.github/cla-signatures.txt` | the Contributor License Agreement every contributor signs, and who has signed it |

Shared configuration lives once, at the root: `tsconfig.base.json`, `.oxlintrc.json`, `.oxfmtrc.json`, `knip.json`, `_typos.toml`, `.markdownlint-cli2.jsonc`, `.jscpd.json`, `REUSE.toml`. Packages extend it; never copy it into a package.

## Rules

1. **Packages are isolated.** A package uses another only through its published name and public exports (`@snowy-media/<name>`), never by relative path into another package. Each package builds, tests and documents itself.
2. **Desktop Chromium only.** Snowy runs in current stable Chromium on desktop (Chrome, Edge), because it opens files only through the File System Access API (rule 3), which Firefox, Safari and Chromium on Android lack. Packages are built, tested, benchmarked and documented for Chromium alone: no code, test, benchmark, CI job or document carries a branch, allowance, workaround or note for another browser engine. Every test runs its code in Chromium, in the build the pinned Playwright version installs (`bunx playwright install chromium`), never in a system browser or a channel and never in Bun: Bun only builds, serves and drives the browser. A test that needs no page is a unit test, `test/**/*.unit.ts`, which `tooling/run-unit.ts` runs in a module worker of a Chromium page, through the package's `test/unit.test.ts`; it imports `test` and `expect` from `tooling/unit.ts`, not `bun:test`, and lint keeps code under test out of a `*.test.ts` file.
3. **Files are persisted handles.** A file the user opens is a `FileSystemFileHandle`, from `showOpenFilePicker` or a dropped item's `getAsFileSystemHandle`, which an app keeps in IndexedDB to open again on a later visit. A public API that opens a user's file takes that handle, never a `File`, `Blob`, URL or `<input type="file">`.
4. **No fallbacks.** One platform baseline (cross-origin isolation, WebAssembly SIMD and threads, WebCodecs, WebGPU, AudioWorklet, File System Access) and one code path. Do not add feature detection, browser-specific branches or main-thread variants.
5. **Performance is measured.** Never claim a speed-up you have not measured; include before and after numbers from the same machine.
6. **Bun and TypeScript only.** Tooling is TypeScript run by Bun. No Node.js or Python scripts; shell only inside Docker builds.
7. **Small, focused diffs.** Change only what the task needs, normally in one package. Match the surrounding style: short functions, comments that explain *why*, SPDX headers on new files (rule 9). `bun run lint` also enforces the house rules: no classes, no `this`, constructor functions or prototypes, and no module-level `let` (keep state in a `createX()` factory); no `let` declared only to be set inside a `try` (return from a small function instead) or wider than its uses; no IIFEs, and no closure rebuilt on each turn of a loop when it uses nothing from that turn; `await` into a `const` instead of nesting it or chaining `.then`; no timer anywhere (`setTimeout`, `setInterval`, `AbortSignal.timeout`, a timed `Atomics.wait`, `requestIdleCallback` with a `timeout`, `scheduler.postTask` with a `delay`; wait on the event instead, though `requestIdleCallback` alone is fine), except the few that model a clock in a bench or end a hung test, which say why in their `oxlint-disable`; no `eval`, `new Function`, code in a string such as `setTimeout("…")`, or `javascript:` URL, since code runs only from modules; no plan, history or conversation in a comment (`TODO`, `for now`, `next PR`, `we changed`), a reason on every `oxlint-disable` (`-- why`), and a blank line around every multi-line block. In engine and sync `src/`, every copy of a collection (a spread, `Array.from`, `slice`, `toSorted`, `structuredClone` and the like) and every read back from the GPU or a frame (`mapAsync`, `copyTextureToBuffer`, `copyTo`) is avoided or says why in a `// copy:` or `// readback:` comment above it. In tests it also enforces rule 11 where it can: no skipped or focused test, an assertion in every test, and no `expect` on only some of a test's paths. Lint holds sizes everywhere, tests and benchmarks included: blocks nested at most 4 deep, a function of at most 80 lines and 4 parameters (pass an options object), and a file of at most 600 lines, blank lines and comments not counted. `bun run lint:duplication` fails on any block of 8 lines and 60 tokens or more repeated in TypeScript or JavaScript: share it instead, and a block that must mirror another, as across packages, sits between `// jscpd:ignore-start: <reason>` and `// jscpd:ignore-end`.
8. **No internal notes in the repository.** No plans, roadmaps, TODO lists, meeting notes or agent scratch files. Documents say what is there, plainly: `bun run lint:md` reports marketing words (`robust`, `seamless`, `powerful`), plan markers (`TODO:`, `next steps`, `Phase 2`) and emoji in headings. A package's README is at most 150 lines, draws the package in a ` ```mermaid ` diagram and ends with its licence; a new `src/` file gets a row in the package's Map, saying what it is for (`bun run lint:structure`). Rationale for the current design goes in the package's `docs/`; user-visible changes go in its `CHANGELOG.md` under *Unreleased*.
9. **Licences have boundaries.** Every file carries the licence of where it lives ([LICENSE.md](LICENSE.md)): `LicenseRef-Snowy-License-1.0` in every package except `packages/ffmpeg`, new packages included; `LGPL-2.1-or-later` in `packages/ffmpeg`; `MIT` for tooling, configuration and root documents. A new package sets `"license": "SEE LICENSE IN LICENSE"` and its release copies the licence text into `LICENSE`. Never move code across a boundary, such as Snowy-licensed code into tooling or FFmpeg's C into another package. Third-party code keeps its own licence and SPDX header and is listed in the package's NOTICE. Changing a licence, `LICENSE.md`, `TRADEMARKS.md` or `CLA.md` is the maintainer's decision, never an agent's.
10. **Packages are headless.** A package is framework-agnostic and unstyled: no CSS, no UI framework or component library, and nothing it adds to the DOM; it draws only into what the app hands it, such as a canvas. It carries no product policy either: no telemetry or analytics, no accounts, billing or usage limits, and no call to a service Snowy runs. Those belong to Snowy's apps and their server. Where an app needs a say, the package takes a neutral extension point, such as a callback, that knows nothing of the app's policy and allows everything when the app passes none. A package never limits quality: no cap on resolution, bitrate, frame rate, length or exports, and no watermark.
11. **Tests are honest.** An expected value comes from a source independent of the code under test, never from that code. A tolerance is the measured spread of the setup it applies to, with its reason in a comment, and is never widened so that one runner passes. A test that could see nothing asserts how much it saw, such as a minimum number of reads, so it cannot pass vacuously. A test waits on an event, never a sleep. Each `src/` file's line coverage by the unit tests may not fall below its floor in the package's `coverage-floor.json`, which CI checks; `bun tooling/check-coverage.ts <name> --update` raises the floors, adds new files and drops gone ones, and lowering a floor is a hand edit with its reason in the pull request. Code run only by page tests or in a worker a test starts, such as the engine's workers or sync's relay, is not measured yet, so its floor is 0 or what the unit tests reach.

## Standards

What every change is held to, and what holds it. A reviewer doesn't repeat what a tool checks; each package's `## Review` section adds what matters there.

| Standard | Held by |
| --- | --- |
| One way of writing code: formatting, the house rules, sizes, no repeated blocks (rule 7) | `bun run check` |
| Each `src/` file says its job in the package's Map; a README is short, drawn and ends with its licence (rule 8) | `bun run lint:structure` |
| Documents say what is there, without marketing words or plans (rule 8) | `bun run lint:md` |
| Tests run the code they claim to: per-file coverage floors (rule 11) | `tooling/check-coverage.ts`, in CI |
| A name says what a file or function holds or does: no `utils`, `helpers`, `manager`, `misc` or `common` | review |
| A file has one job, which its Map row names | review |
| A comment says why, never what the next line does or how the code came to be | review |
| One way per concern: errors, cleanup, events and state follow what the package already does | review |
| Nothing written twice that the duplication check misses: a second helper, constant or type for the same thing | review |
| A test fails for the bug it names: its expectation comes from an independent source, and no change loosens an assertion in the same diff that changes the code it checks | review, and the `verify-tests` skill |

## Before you open a pull request

1. `bun run check` and `bun test` pass, plus any extra check the package's AGENTS.md asks for.
2. Review your own diff with the `code-reviewer` agent (`.claude/agents/code-reviewer.md`) in a fresh context, and fix what it finds. It holds the diff to the standards above and the `## Review` section of each package it touches.
3. Title the pull request as a Conventional Commit, fill in the template, and say which parts an agent wrote.

## Skills

Task playbooks in [`.agents/skills`](.agents/skills) (also linked into `.claude/skills`). Skills for one package are prefixed with its name and listed in its AGENTS.md.

| Skill | Use it to |
| --- | --- |
| `audit-package` | audit a whole package against the standards and its `## Review` section, and rank what is wrong |
| `triage-issue` | label a new issue and ask for what is missing |
| `verify-tests` | find what the tests miss, by breaking the code on purpose and seeing which change no test catches |
| `write-readme` | write or rewrite a package's README in the shape `lint:structure` checks |

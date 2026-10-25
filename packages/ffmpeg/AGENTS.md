# Agent guide: @snowy-media/ffmpeg

The [root AGENTS.md](../../AGENTS.md) applies here too; this file adds what is specific to this package. Paths and commands below are relative to `packages/ffmpeg/`.

This package compiles FFmpeg to WebAssembly modules that browsers call directly from a worker. The output is judged on three things, in this order: **correct** (matches native FFmpeg), **fast** (measured, never assumed), **small**. It is LGPL-2.1-or-later, like FFmpeg; new files carry that SPDX identifier.

## Commands

| Task | Command |
| --- | --- |
| Build every module into `dist/` (Docker) | `bun run build` |
| Browser tests (Chromium) | `bun test` |
| Demux benchmark | `bun run bench --runs 3` |
| Audio decode benchmark | `bun run bench:audio --runs 3` |
| Video decode benchmark | `bun run bench:video --runs 3` |
| Regenerate fixtures (needs native FFmpeg 9.0.2) | `bun run fixtures` |

A full FFmpeg build takes 20+ minutes; changing only `src/` relinks in under a minute.

## Map

| Path | What it holds |
| --- | --- |
| `Dockerfile` | the only build path; every pinned version and checksum |
| `build/configure.sh` | FFmpeg configure flags per module; which decoders go to `audio-ext` and `video` |
| `src/*.c` | the entire JavaScript API of each module (getters, open/read/seek, decoding) |
| `src/sny.h` | what the API files share, and which files each module is built from |
| `src/io.js` | Emscripten imports that route AVIO reads to JavaScript hooks |
| `scripts/gen-dts.ts` | generates `dist/<module>/index.{js,d.ts}` from `src/*.c` |
| `scripts/gen-fixtures.ts` | builds `test/fixtures` and `expected.json` from native `ffprobe` |
| `scripts/release.ts` | release notes, `LICENSE` and the LGPL source archive for a tag |
| `test/` | Playwright tests; `test/support/` is shared with `bench/` |
| `bench/` | benchmark harness, library adapters, recorded results |
| `docs/architecture.md` | design and the reasons behind it |
| `docs/decoding.md` | decoding audio and video after demuxing, for users |

## Rules

1. **The boundary is `src/*.c`.** JavaScript never reads FFmpeg memory by offset. A new field is a one-line `API` getter; a new constant is a `SNY_CONST` line. Then run `bun scripts/gen-dts.ts`. Never edit anything in `dist/`. See the `ffmpeg-add-api` skill.
2. **Expected results come from native FFmpeg.** Never hand-write a test expectation. Add the case to `scripts/gen-fixtures.ts` and regenerate, so `ffprobe` 9.0.2 decides what is correct.
3. **Performance is measured.** A change that can affect speed or size includes `bun run bench` numbers before and after, from the same machine.
4. **Everything is pinned.** Versions and sha256 checksums live in the `Dockerfile` only; never fetch anything unpinned. When the build output changes, update `dist.sha256` in the same commit and say why in the pull request. See the `ffmpeg-update-dependency` skill.
5. **One configuration.** Every module is built with SIMD, threads and LTO. Do not add non-SIMD or single-threaded builds.

Before a pull request that touches the `Dockerfile`, `build/` or `src/`, rebuild and check `shasum -a 256 -c dist.sha256`.

## Review

Beyond the rules above and [docs/architecture.md](docs/architecture.md), a reviewer checks:

- **FFmpeg use.** Every negative `AVERROR` return is checked; every `av_*alloc` and `sny_open` has its free or close on every path, errors included; timestamps and sizes stay `int64_t` in C and `bigint` in JavaScript; I/O positions are right at both ends.
- **Copies and reads.** No extra copy of packet data, no allocation per packet in JavaScript, and no small reads through `FileReaderSync`.

## Skills

| Skill | Use it to |
| --- | --- |
| `ffmpeg-add-api` | expose a new FFmpeg field, function or constant to JavaScript |
| `ffmpeg-fix-format` | reproduce and fix a file that won't open or demuxes wrong |
| `ffmpeg-update-dependency` | bump FFmpeg, Emscripten, dav1d, zlib or bzip2 |
| `ffmpeg-benchmark` | measure a performance or size change and report it |

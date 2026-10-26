# Agent guide: @snowy-media/engine

The [root AGENTS.md](../../AGENTS.md) applies here too; this file adds what is specific to this package. Paths and commands below are relative to `packages/engine/`.

This package is the playback pipeline of Snowy, without any user interface: it reads a file, demuxes and decodes it, keeps audio and video in sync and draws into a canvas. The player and the editor build on it. Read [docs/architecture.md](docs/architecture.md) before changing it.

## Commands

| Task | Command |
| --- | --- |
| Build the package into `dist/`: the bundles and the declarations of the public API (`tsconfig.dts.json`) | `bun run build` |
| Browser tests (Chromium) | `bun run test` |
| The tests as on a budget laptop ([architecture](docs/architecture.md#low-end)) | `bun run test:low-end` |
| Benchmarks | `bun run bench --runs 5` |
| The benchmarks as on a budget laptop | `bun run bench:low-end --runs 5` |
| Regenerate the fixtures (needs native FFmpeg 9.0.2) | `bun run fixtures` |

The tests and benchmarks build what they run, and need `@snowy-media/ffmpeg` built first (`bun run build` in `packages/ffmpeg`; CI takes it from the ffmpeg build job). They need WebGPU on a GPU: macOS, Windows, or Linux with a GPU; or in software with `SNOWY_GPU=warp` on Windows and `SNOWY_GPU=swiftshader` on Linux, as CI runs them ([architecture](docs/architecture.md#testing)).

## Map

| Path | What it holds |
| --- | --- |
| `src/index.ts` | the public API, and the player on the main thread: open, play, pause, seek and scrub |
| `src/playback.ts` | one play on the main thread: its rings and audio output, the output timestamp it publishes, and whether it may start and is heard |
| `src/platform.ts` | the platform check on the main thread, and `UnsupportedPlatformError` |
| `src/media.worker.ts` | the media worker: reads and demuxes the file, and decodes and resamples its audio, with the FFmpeg core |
| `src/audio-decoder.ts` | the media worker's audio decoder: a queue of an audio stream's packets, decoded and resampled into the PCM ring |
| `src/io.ts` | the media worker's synchronous reads from a `File` |
| `src/ring.ts` | the packet ring between two threads |
| `src/codec.ts` | WebCodecs decoder configs, with the codec string from a stream's configuration record or parameter sets |
| `src/video.ts` | the render worker's video output: decoding from the packet ring, with WebCodecs or FFmpeg, and presentation |
| `src/wasm-video.ts` | the render worker's decoders for the codecs WebCodecs does not decode, in the video decode worker |
| `src/video.worker.ts` | the video decode worker: decodes those codecs with the FFmpeg `video` and `video-ext` modules |
| `src/frames.ts` | the frame queue, in presentation order and bounded by bytes |
| `src/decoding.ts` | how far a video decoder has decoded, whatever order it emits frames in |
| `src/compositor.ts` | the WebGPU compositor: a frame uploaded and converted from Y′CbCr as FFmpeg converts it, turned by its display matrix, fitted into the canvas |
| `src/shaders.ts` | the compositor's WGSL shaders and the render pipelines made of them |
| `src/pictures.ts` | the compositor's pictures: a frame's textures laid out by pixel format, pooled by size and format |
| `src/colour.ts` | the colour matrices: plane values to R′G′B′ as FFmpeg converts them, and undoing the matrix Chromium took |
| `src/measure.ts` | how a stream's frames go up: Chromium's conversion measured against the compositor's on a grid of points |
| `src/view.ts` | where a picture is drawn: the map from the canvas to it by its display matrix, fitted and centred |
| `src/webgpu.d.ts` | the WebGPU flag constants TypeScript's libraries leave out |
| `src/pcm.ts` | the PCM ring from the media worker to the AudioWorklet, and the clock |
| `src/audio.ts` | the audio output on the main thread |
| `src/audio.worklet.ts` | the AudioWorklet: plays the PCM ring and publishes the clock |
| `src/render.worker.ts` | the render worker: the platform check, then video on its animation frames |
| `src/protocol.ts` | the messages between threads, and the records between the render worker and the video decode worker |
| `scripts/build.ts` | bundles each thread's entry point into `dist/`, or for the tests into `test/dist/` |
| `scripts/release.ts` | packs and checks the npm package for a release tag (CONTRIBUTING.md#releasing) |
| `scripts/gen-fixtures.ts` | builds `test/fixtures` and `expected.json` from native FFmpeg |
| `test/` | Playwright tests; `test/support/` is shared with `bench/`, and `serve.ts` builds and serves the engine for both, and `page.ts` is the code their pages import |
| `bench/` | benchmarks ([README](bench/README.md)) |
| `docs/architecture.md` | design and the reasons behind it |

## Rules

1. **Know which thread you are on.** Each thread has one job and its own entry point in `scripts/build.ts`. The main thread and the render worker never block. A worker file ends in `.worker.ts` and is typechecked against the worker globals (`tsconfig.worker.json`), and the AudioWorklet in `.worklet.ts` against its own (`tsconfig.worklet.json`).
2. **The platform check is the only feature check.** A new requirement is a new `PlatformFeature`, checked in `src/platform.ts` or the render worker. Code elsewhere assumes the baseline and never tests for a feature.
3. **No allocation per frame or per packet.** Hot paths reuse buffers, shared rings and GPU textures that are allocated once.
4. **Queues are bounded by bytes,** never by an item count, so memory stays bounded at any resolution.
5. **No runtime dependencies** besides `@snowy-media/ffmpeg`.
6. **Expected results come from native FFmpeg,** as root rule 11 asks of every test. Never hand-write a timestamp or a frame count: add the case to `scripts/gen-fixtures.ts` and regenerate.
7. **Performance is measured** with `bun run bench`, before and after, on the same machine; work that moves decoding or conversion onto the CPU also with `bun run bench:low-end` and `bun run test:low-end`, which need a Mac with efficiency cores (docs/architecture.md#low-end).
8. **No interface.** The engine adds nothing to the DOM: it draws into the canvas it is handed and plays through its own `AudioContext`; the player and the editor own the interface.
9. **A failure is reported once and never blocks.** The thread that hits it reports why to the main thread; the threads it reaches through a ring or a message stop without reporting it again. Reporting a failure never waits for room in a ring or for a reader. A promise that can reject has a handler before it can.
10. **Stopping leaves nothing behind.** After a stop, a close or a failure, whatever was waiting is resolved or rejected, and no state of that run, such as a flag, a half-sent packet or a pending promise, reaches the next.

## Review

Beyond the rules above, a reviewer checks:

- **Copies.** Each copy of packet, sample or frame data and each read back from the GPU is one the path cannot do without, and its `// copy:` or `// readback:` reason is true. A WebCodecs frame is imported, never read back, wherever its colour measures as FFmpeg's ([Colour](docs/architecture.md#colour)), and an FFmpeg frame is uploaded from the module's memory without a copy on the CPU.
- **Transfers.** A buffer posted to another thread is transferred or shared, never cloned.
- **One path per job.** Codecs and pixel formats share the decode, convert and draw code instead of growing a parallel copy each.

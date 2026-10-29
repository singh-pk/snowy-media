<!-- markdownlint-configure-file { "MD043": { "headings": ["# Changelog", "## [Unreleased]", "*"] } } -->

# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Video in the codecs WebCodecs does not decode, such as MPEG-2, MPEG-4 Part 2, ProRes, DNxHD and FFV1, plays: `@snowy-media/ffmpeg` decodes it in a worker of its own, loading its `video` module, or `video-ext` for rarer codecs, the first time a file needs it.
- `engine.compose` plays a composition of one clip of a file. The composition is a length, a plan in the shape of `@snowy-media/timeline`'s render plan, and the file of each asset. The clip plays from its in point to its out point, at its place on the composition, with black and silence before and after it, and the clock runs on to the composition's end. `engine.changed` reads the length and plan again after an edit. A picture and its sound play together when they come from one file, placed alike and cut at the same time, as two clips of a timeline do. A plan with more than one layer, a transition, an effect, a speed, or any opacity, blend, transform, gain, pan or fade fails with a NotSupportedError that says which.
- A file without audio plays, and video that outlasts its audio plays to its end, by up to as much as the 8 MiB packet ring holds: past the audio, the clock runs on through silence as far as the video's packets reach.

### Changed

- The engine is now under the [Snowy License 1.0](https://github.com/singh-pk/snowy-media/blob/main/LICENSES/LicenseRef-Snowy-License-1.0.txt) instead of MIT. It stays free for individuals, companies of up to 3 people, non-profits, education, open-source projects and evaluation; larger companies using it in production need a company licence ([LICENSE.md](https://github.com/singh-pk/snowy-media/blob/main/LICENSE.md)). Version 0.1.0 and earlier stay under MIT.
- Video colour now matches native FFmpeg's whatever decoded it. The engine converts Y′CbCr to RGB itself, from the colour the stream states, where Chromium converted it differently for hardware and software decoders. A stream that states no matrix shows as BT.601, as FFmpeg shows it. HDR from a software decoder shows its signal, as FFmpeg shows it, not tone-mapped as Chromium did. Chromium still converts a 10-bit frame from a GPU decoder.
- Video that WebCodecs decodes plays on less CPU: a frame whose conversion by Chromium matches FFmpeg's, as each decoder's first frames show, is drawn straight from the GPU instead of copied off it, 4K60 H.264 on about a third less on a budget laptop. A WebCodecs decoder's config now states what the stream leaves out of its colour as FFmpeg takes it.
- A WebCodecs frame that Chromium converts with another matrix or range than the stream states, such as untagged 4K H.264 from the macOS hardware decoder, is drawn straight from the GPU too, its conversion undone in the shader, where Chromium does not clip: that 4K stream plays on about a third less CPU, and on a budget laptop on under half.
- Video that FFmpeg decodes, such as ProRes and DNxHD, decodes up to a third faster: packets and frames pass between the render worker and the video decode worker through shared rings, not a message each.
- A WebCodecs stream whose first frames are too muted to show the matrix or range Chromium took is measured on its later frames, up to the first 60, where its planes were read back for the whole play: such an untagged 4K H.264 stream on macOS plays on about a quarter less CPU.
- The render worker no longer copies each packet of video that FFmpeg decodes: the video decode worker copies it straight from the packet ring into FFmpeg's memory. For 4K ProRes HQ, the render worker spends a tenth of the time it did on packets, 0.34 ms a second instead of 3.2 on an Apple M5.

### Fixed

- A paused `seek`, and a `fastSeek` that scrubs, resolves with its frame on screen, as it says, not just sent to the GPU: the first frame of a page could still be black, or the frame before, on a GPU slow to draw it.
- `engine.currentTime` no longer goes back as `pause` stops it, by up to 20 ms, which could leave the frame on screen two frames ahead of the paused clock.
- Paused while video runs behind, the frame due no longer stays off screen for the whole pause, an older frame showing instead.
- A `pause`, `open` or `close` settles a `play` still waiting for the browser to allow audio; it no longer stays pending until a user gesture.
- `play` resolves once the frame due by the clock heard is on screen, not as soon as the clock runs, and a `seek` while playing that a `pause` interrupts resolves once its frame is on screen, as a paused seek does.
- A video packet larger than 8 MiB, as a 4K FFV1 or ProRes 4444 XQ frame may be, plays: it goes through the rings between threads in pieces, where it failed with `exceeds the ring`.
- A demux failure reports its own error, not `demuxing failed`, and the media worker never hangs reporting it while its ring is full and no longer read.
- Closing an FFmpeg-decoded video stream without flushing it no longer leaves an unhandled promise rejection in the render worker.
- A `seek` or `fastSeek` after `open`, a failure or a `play` that rejected no longer starts playing: only a `play` since then makes a seek play on.
- WebCodecs video decoders now get the colour the file states (primaries, transfer, matrix and range), so a VP9 HDR stream, whose bitstream does not state its transfer, is no longer decoded as BT.709 SDR.

## [0.1.0] - 2026-10-24

### Added

- `createEngine({ canvas })`, which checks the platform once and rejects with an `UnsupportedPlatformError` naming the first missing feature: cross-origin isolation, WebAssembly SIMD or threads, AudioWorklet, OffscreenCanvas, WebGPU in a worker, WebCodecs, or importing a `VideoFrame` as a WebGPU texture.
- `engine.open(handle)`, which reads the file behind a `FileSystemFileHandle` (from `showOpenFilePicker`, a drop, or IndexedDB once permission is granted again) in a worker and resolves with its container format, duration and tracks: codec, plus size for video and sample rate and channels for audio, or rejects with an `AbortError` if a later open is called first. It clears the canvas to black, so nothing of the file before stays on screen.
- `engine.play()`, `engine.pause()` and `engine.currentTime`: the open file's first video and first audio track play in sync, with the frame on screen the one due at the time being heard. Video demuxes ahead of the audio, so the last frames of sparse video, or of video that ends before the audio, show on time. Files without audio do not play yet.
- `engine.seek(time)`, which goes to the frame due at `time`, exactly, paused or playing, with the clock at `time` to the sample.
- `engine.fastSeek(time)`, for scrubbing: called on every pointer move, the screen follows as fast as it decodes, decoding on through frames instead of starting again where it can, and lands on the frame due at the last `time`.

### Changed

- Supported and tested in current stable desktop Chromium only (Chrome, Edge); Firefox and WebKit are no longer tested or benchmarked.

[Unreleased]: https://github.com/singh-pk/snowy-media/compare/@snowy-media/engine@0.1.0...HEAD
[0.1.0]: https://github.com/singh-pk/snowy-media/releases/tag/@snowy-media/engine@0.1.0

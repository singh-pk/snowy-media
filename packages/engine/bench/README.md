# Benchmarks

`bun run bench` runs each benchmark in Chromium on a GPU, in a fresh browser per run, and prints the median of `--runs` runs, in milliseconds unless the row says otherwise. `bun run bench:low-end` runs them as on a budget laptop ([architecture](../docs/architecture.md#low-end)). `--out bench/results/<name>.json` also writes the numbers, for a pull request that claims a change in speed.

| Benchmark | Measures |
| --- | --- |
| `startup` | `createEngine` until it resolves: the platform check, starting the render worker and opening a GPU device. `cold` is the first engine in a page, `warm` a second one with the worker script cached |
| `open` | `engine.open` until it resolves, for a file in the origin's private file system. `first` is the first file in a new engine, including whatever is left of loading the FFmpeg core; `long` is a ten-minute MP4 after it |
| `ring` | the packet ring between two workers at the engine's capacity: moving 256 MiB in packets of 1 KiB, 64 KiB and 1 MiB, and how late the consumer wakes up for a packet written every 2 ms (`wake p50` and `wake p99`). The consumer does not read the payloads, so the throughput is the producer's copy and the bookkeeping |
| `audio` | the media worker decoding the ten-minute AAC track into the PCM ring, as the page drains it: in stereo at 48 kHz, the track's own rate, and resampled to 44.1 kHz |
| `scrub` | a drag through a 4K H.264 file from its start to 9 s with no keyframe on the way, at 2 s of it a second, `engine.fastSeek` on every animation frame: how far the frame on screen is behind the drag, in media time and with the canvas's read-back included (`lag p50`, `lag p90`), and from the last call until it resolves (`settle`) |
| `play` | the same 4K file played from its start for 8 s, the screen read on every animation frame: how late the frame on screen is for the time heard, past when the next frame was due, with the canvas's read-back included (`late p50`, `late p90`, `late p99`, `late max`), and the CPU time of every browser process over the time played, in cores (`cpu cores`), the read-back included, and how far the clock got in the 8 s (`reached s`), short of 8 where the machine falls behind: for comparing runs on one machine and profile |

CI runs them on every engine change and shows the table in the job summary. Shared runners are noisy, so CI does not fail on a slowdown; compare numbers from one machine.

To add a benchmark, add an entry to `benchmarks` in [`run.ts`](run.ts) and a row here.

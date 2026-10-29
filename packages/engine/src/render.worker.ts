// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The render worker (docs/architecture.md#playback). It checks the baseline only a worker can see:
// WebGPU on an OffscreenCanvas, WebCodecs, and importing a VideoFrame as a GPU texture, the path
// every WebCodecs frame takes. Then, on each animation frame, it shows the frame due when that
// animation frame reaches the screen, by the audio clock.

import { createCompositor } from "./compositor";
import { createPcmControl } from "./pcm";
import type { FromRender, Missing, ToRender } from "./protocol";
import { createVideoOutput } from "./video";
import { createWasmVideo } from "./wasm-video";

interface Gpu {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
}

// The refresh is the shortest of the last GAPS gaps between animation frames, so one late
// animation frame does not move the next frame's target; until GAPS gaps are timed, the rest
// count as REFRESH. A gap of LONGEST_REFRESH or more is a stall, not the display's rate.
const REFRESH = 1000 / 60;
const LONGEST_REFRESH = 50;
const GAPS = 8;
// The video decoded before the main thread starts audio, in microseconds, as much as the audio
// it buffers: a decoder that has just started delivers its next frames slowly.
const PREROLL = 250_000;

// Decoders for the codecs WebCodecs does not decode, in a worker of their own, started once
// a stream needs one.
const wasm = createWasmVideo();

const state = {
  compositor: undefined as ReturnType<typeof createCompositor> | undefined,
  playing: undefined as Playing | undefined,
};

type Playing = ReturnType<typeof createPlaying>;
type Timing = ReturnType<typeof createTiming>;

function post(message: FromRender) {
  self.postMessage(message);
}

// The play `id` of `output` from `from`, and what the main thread was last told of it.
function createPlaying(id: number, output: ReturnType<typeof createVideoOutput>, from: number) {
  return {
    id,
    output,
    frame: 0,
    first: Number.NaN,
    reported: -1,
    reportedReached: -1,
    ahead: false,
    stuck: false,
    shown: false,
    // `target` is where it plays from, which a scrub moves on. `drawn` and `reached` (-1 for
    // none) say whether the start's frame is drawn and the last target reached, once the GPU has
    // done them; `sent` holds the same as sent to the GPU; `waiting`, whether the GPU is waited on.
    target: from,
    drawn: false,
    reached: -1,
    sent: { drawn: false, reached: -1 },
    waiting: false,
  };
}

function createTiming() {
  return { last: 0, next: 0, gaps: new Float64Array(GAPS).fill(REFRESH) };
}

// Counts the animation frame that started at `time`, and returns the display's refresh.
function refreshAt(timing: Timing, time: number) {
  const gap = time - timing.last;

  if (timing.last > 0 && gap < LONGEST_REFRESH) {
    timing.gaps[timing.next] = gap;
    timing.next = (timing.next + 1) % GAPS;
  }

  timing.last = time;
  let refresh = LONGEST_REFRESH;
  // Indexed: an iterator would allocate on every animation frame.
  for (let i = 0; i < GAPS; i++) refresh = Math.min(refresh, timing.gaps[i] ?? REFRESH);
  return refresh;
}

// Posts how far decoding is, and whether a frame went up by the running clock, if it changed.
function report(playing: Playing) {
  const { id, ahead, stuck, drawn, shown, reached } = playing;
  const now = (ahead ? 1 : 0) | (stuck ? 2 : 0) | (drawn ? 4 : 0) | (shown ? 8 : 0);
  if (now === playing.reported && reached === playing.reportedReached) return;
  playing.reported = now;
  playing.reportedReached = reached;
  post({ type: "video", id, ahead, stuck, drawn, shown, reached });
}

// Once the GPU has done the work sent to it, reports the start's frame drawn and a scrub's target
// reached as they were when sent. A paused seek and a scrub resolve on these, and a GPU that
// compiles a draw the first time it runs, as a software one does, may take many refreshes.
async function reportDone(
  playing: Playing,
  compositor: ReturnType<typeof createCompositor>,
  fail: (e: unknown) => void,
) {
  playing.waiting = true;
  const { drawn, reached } = playing.sent;

  try {
    await compositor.done();
  } catch (e) {
    fail(e);
    return;
  }

  if (state.playing !== playing) return;
  playing.waiting = false;
  Object.assign(playing, { drawn, reached });
  report(playing);
}

async function openGPU(canvas: OffscreenCanvas): Promise<Gpu | Missing> {
  if (!("gpu" in navigator)) return ["webgpu", "navigator.gpu is missing"];

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return ["webgpu", "no GPU adapter"];
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");

    if (!(context instanceof GPUCanvasContext)) {
      return ["webgpu", "no WebGPU context for an OffscreenCanvas in a worker"];
    }

    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "opaque" });
    return { device, context, format };
  } catch (e) {
    return ["webgpu", String(e)];
  }
}

function createFrame(): VideoFrame | Missing {
  if (typeof VideoDecoder === "undefined") return ["webcodecs", "VideoDecoder is missing"];

  try {
    const options = { format: "RGBA", codedWidth: 2, codedHeight: 2, timestamp: 0 } as const;
    return new VideoFrame(new Uint8Array(16), options);
  } catch (e) {
    return ["webcodecs", String(e)];
  }
}

async function check(canvas: OffscreenCanvas): Promise<Gpu | Missing> {
  const gpu = await openGPU(canvas);
  if (Array.isArray(gpu)) return gpu;
  const frame = createFrame();
  if (Array.isArray(frame)) return frame;

  try {
    gpu.device.importExternalTexture({ source: frame });
    return gpu;
  } catch (e) {
    return ["webgpu-external-texture", String(e)];
  } finally {
    frame.close();
  }
}

async function init(canvas: OffscreenCanvas) {
  const gpu = await check(canvas);

  if (Array.isArray(gpu)) {
    post({ type: "unsupported", missing: gpu });
    return;
  }

  state.compositor = createCompositor(gpu.device, gpu.context, gpu.format);
  post({ type: "ready" });
}

function scrub({ id, to }: Extract<ToRender, { type: "scrub" }>) {
  if (state.playing?.id !== id) return;
  state.playing.target = to;
  state.playing.output.moveTo(to);
}

function stop() {
  if (!state.playing) return;
  self.cancelAnimationFrame(state.playing.frame);
  state.playing.output.close();
  state.playing = undefined;
}

// Stops what plays, and leaves the canvas black, with nothing of the file before.
function clear() {
  stop();
  if (!state.compositor) throw new Error("clear before init");
  state.compositor.clear();
}

// Whether media time `at` (microseconds) is outside a clip's `window`, where the canvas is black.
const outside = (window: Window | undefined, at: number) =>
  window !== undefined && (at < window.in || at >= window.out);

type Window = Extract<ToRender, { type: "play" }>["window"];

function play({ id, ring, params, pcm, from, window }: Extract<ToRender, { type: "play" }>) {
  stop();
  if (!state.compositor) throw new Error("play before init");
  const compositor = state.compositor;
  const clock = createPcmControl(pcm);
  // `changed` and `freed` fire only in later tasks, once `playing` below exists. The media worker
  // waits on the PCM ring's doorbell for room in either ring (src/pcm.ts).
  const output = createVideoOutput(ring, params, {
    compositor,
    wasm,
    changed: () => update(),
    freed: clock.wakeProducer,
    from,
  });
  // In a gap before a clip, the clock starts before its video does.
  const playing = createPlaying(id, output, window?.start ?? from);
  const timing = createTiming();

  // Reports the first failure of this play, unless it has stopped.
  function fail(e: unknown) {
    if (state.playing !== playing) return;
    stop();
    post({ type: "error", id, message: e instanceof Error ? e.message : String(e) });
  }

  // `time` is when this animation frame started; what it draws is seen one refresh later.
  function draw(time: number) {
    const refresh = refreshAt(timing, time);

    try {
      // Read before `heard`: if the timestamp was running then, the time heard below was carried
      // forward from it, so the frame put up is the latest due.
      const running = clock.outputRunning();
      const seen = clock.heard(performance.timeOrigin + time + refresh);
      // The clock starts up to a sample before the target; no frame due before the target shows.
      const at = Math.max(Math.round(seen * 1e6), playing.target);
      const black = outside(window, at);
      if (black) output.blank();
      // Before the clip, its first frame is uploaded ahead, so it is up when due.
      if (black && window && at < window.in) void output.prepare(window.in);
      const drawn = black || output.present(at);
      // Shown by the running clock once a frame is up and none due by then is still going up,
      // not merely while the clock runs, so a decoder slower than the clock still gets there.
      // Black counts as shown at once.
      const shown = running && (black || output.current(at));
      const { sent } = playing;
      sent.drawn ||= drawn;
      if (output.reached(playing.target)) sent.reached = playing.target;
      const unsent = sent.drawn !== playing.drawn || sent.reached !== playing.reached;
      if (unsent && !playing.waiting) void reportDone(playing, compositor, fail);

      if (shown && !playing.shown) {
        playing.shown = true;
        report(playing);
      }
    } catch (e) {
      fail(e);
      return;
    }

    playing.frame = self.requestAnimationFrame(draw);
  }

  // Reports progress for the main thread's preroll, until a frame is shown by the running clock.
  // Video is stuck only once the media worker is blocked, on a full PCM ring while the context is
  // held or on a full packet ring, and video then starves or fills its frame queue.
  function update() {
    if (state.playing !== playing || playing.shown) return;
    // Watched first, so the media worker blocking after the read below runs this again.
    output.watch();
    const blocked = clock.producerWaiting() || output.blocked();
    const decoded = output.decodedTo();
    // Preroll counts from `from`: the frames before it are decoded, and all but the last dropped.
    if (Number.isNaN(playing.first) && decoded > -Infinity) playing.first = Math.max(decoded, from);
    playing.ahead = decoded - playing.first >= PREROLL || output.ended();
    playing.stuck = blocked && (output.starved() || output.full());
    report(playing);
  }

  async function watch() {
    try {
      await output.done;
    } catch (e) {
      fail(e);
    }
  }

  playing.frame = self.requestAnimationFrame(draw);
  state.playing = playing;
  update();
  void watch();
}

self.addEventListener("message", ({ data }: MessageEvent<ToRender>) => {
  if (data.type === "init") void init(data.canvas);
  else if (data.type === "play") play(data);
  else if (data.type === "scrub") scrub(data);
  else if (data.type === "clear") clear();
  else stop();
});

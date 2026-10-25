// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The render worker. It checks the part of the platform baseline only a worker can see:
// WebGPU on an OffscreenCanvas, WebCodecs, and a VideoFrame imported as a GPU texture, the
// path every WebCodecs frame takes to the screen. Then it plays video: on each animation
// frame it shows the frame due when that animation frame reaches the screen, by the audio
// clock (src/pcm.ts).

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

// An animation frame's length until two have been timed, and the longest one counted: a
// longer gap is a stall, not the display's rate. The refresh is the shortest of the last
// GAPS gaps, so one late animation frame does not move the next frame's target.
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
  // What plays, and its animation frame request.
  playing: undefined as
    | { id: number; output: ReturnType<typeof createVideoOutput>; frame: number; target: number }
    | undefined,
};

function post(message: FromRender) {
  self.postMessage(message);
}

// A device drawing into `canvas`, or what is missing for one.
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

// A 2×2 VideoFrame, or what is missing for one.
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

// Moves the play `id`, if it still plays, on to `to`.
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

function play({ id, ring, params, pcm, from }: Extract<ToRender, { type: "play" }>) {
  stop();
  if (!state.compositor) throw new Error("play before init");
  const clock = createPcmControl(pcm);
  // Its events all come in later tasks, once `playing` below is made. The media worker waits on
  // the PCM ring's doorbell for room in either ring (src/pcm.ts).
  const output = createVideoOutput(
    ring,
    params,
    state.compositor,
    wasm,
    () => update(),
    clock.wakeProducer,
    from,
  );
  const playing = {
    id,
    output,
    frame: 0,
    first: Number.NaN,
    reported: -1,
    reportedReached: -1,
    ahead: false,
    stuck: false,
    drawn: false,
    shown: false,
    // Where it plays from, which a scrub moves on, and the last such target reached, or -1.
    target: from,
    reached: -1,
  };
  const timing = { last: 0, next: 0, gaps: new Float64Array(GAPS).fill(REFRESH) };

  // Reports the first failure of this play, unless it has stopped.
  function fail(e: unknown) {
    if (state.playing !== playing) return;
    stop();
    post({ type: "error", id, message: e instanceof Error ? e.message : String(e) });
  }

  // `time` is when this animation frame started; what it draws is seen one refresh later.
  function draw(time: number) {
    const gap = time - timing.last;

    if (timing.last > 0 && gap < LONGEST_REFRESH) {
      timing.gaps[timing.next] = gap;
      timing.next = (timing.next + 1) % GAPS;
    }

    timing.last = time;
    let refresh = LONGEST_REFRESH;
    // Indexed: an iterator would allocate on every animation frame.
    for (let i = 0; i < GAPS; i++) refresh = Math.min(refresh, timing.gaps[i] ?? REFRESH);

    try {
      // Read first: if the timestamp ran then, the time heard below was carried forward by it,
      // so the frame put up is the latest due.
      const running = clock.outputRunning();
      const seen = clock.heard(performance.timeOrigin + time + refresh);
      // The clock starts up to a sample before `from`: the frame shown is never one before.
      const at = Math.max(Math.round(seen * 1e6), playing.target);
      const drawn = output.present(at);
      // Shown by the running clock once a frame is up and none due by it is still going up,
      // not just as it runs; a decoder slower than the clock still lets it be shown.
      const shown = running && output.current(at);
      const reached = output.reached(playing.target) ? playing.target : playing.reached;

      if ((drawn && !playing.drawn) || (shown && !playing.shown) || reached !== playing.reached) {
        playing.drawn ||= drawn;
        playing.shown ||= shown;
        playing.reached = reached;
        report();
      }
    } catch (e) {
      fail(e);
      return;
    }

    playing.frame = self.requestAnimationFrame(draw);
  }

  // How far decoding is, for the main thread's preroll, on each event that may change it, until
  // a frame is shown by the running clock. Stuck is read with the media worker blocked first:
  // on a full PCM ring, which stays full while the context is held, or on a full packet ring;
  // after that, video starved or full gets no further.
  function update() {
    if (state.playing !== playing || playing.shown) return;
    // Watched first, so the media worker blocking after the read below runs this again.
    output.watch();
    const blocked = clock.producerWaiting() || output.blocked();
    const decoded = output.decodedTo();
    // From the target: the frames before it are decoded, and all but one dropped.
    if (Number.isNaN(playing.first) && decoded > -Infinity) playing.first = Math.max(decoded, from);
    playing.ahead = decoded - playing.first >= PREROLL || output.ended();
    playing.stuck = blocked && (output.starved() || output.full());
    report();
  }

  // Posts how far decoding is, and whether a frame went up by the running clock, if it changed.
  function report() {
    const { ahead, stuck, drawn, shown, reached } = playing;
    const now = (ahead ? 1 : 0) | (stuck ? 2 : 0) | (drawn ? 4 : 0) | (shown ? 8 : 0);
    if (now === playing.reported && reached === playing.reportedReached) return;
    playing.reported = now;
    playing.reportedReached = reached;
    post({ type: "video", id, ahead, stuck, drawn, shown, reached });
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

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// How a stream's frames go up, measured on its own frames (docs/architecture.md#colour): to tell
// whether Chromium converts them as FFmpeg does, with Apple's gamma, or through another matrix or
// range that can be undone.

import { identity, undoMatrix } from "./colour";
import { planeViews, type Slot } from "./pictures";
import { MEASURED } from "./shaders";

// The grid of points a frame is measured at. Each conversion of a point is read back as four
// 32-bit floats, so a row is 2048 bytes, a multiple of the 256 bytes a texture copy's rows need.
const GRID_WIDTH = 128;
const GRID_HEIGHT = 72;
const GRID_ROW = GRID_WIDTH * 16;
// Only channels neither near black nor near white tell the two conversions apart, and in a sharp
// frame, such as colour bars, those lie only along its edges. With fewer than MIN_POINTS of them,
// as in a dark frame, the next frame is measured.
const MIDTONES = [0.1, 0.9] as const;
const MIN_POINTS = 300;
// A point is coloured when its channels differ by more than COLOURED. Only coloured points tell
// one matrix from another, so a near-grey frame, with fewer than MIN_COLOURED, decides nothing.
const COLOURED = 0.1;
const MIN_COLOURED = 400;
// How many frames are measured before giving up on a stream, such as a dark, grey or muted one,
// or one Chromium clips. Its planes are then read back, as for a stream that is never measured.
const MAX_TRIES = 60;
// How far Chromium's conversion may be from the compositor's, at the median and the 95th
// percentile of the points: the two filter differently at edges, and Apple's gamma moves a
// midtone by 11 levels of 255.
const MEDIAN_OFF = 1.5 / 255;
const P95_OFF = 6 / 255;
// Undoing a matrix mixes the channels, so it needs Chromium's conversion unclipped, as shown by
// at least BEYOND_POINTS channels more than BEYOND below 0 and as many above 1 (a clip may be at
// one end only). A frame whose colours all fit inside decides nothing; a later one is measured.
const BEYOND = 2 / 255;
const BEYOND_POINTS = 10;

/**
 * How the frames of a stream whose planes can be read go up, decided from its own frames
 * (docs/architecture.md#colour). While `via` is `unmeasured`, the planes are read back and
 * converted by the compositor. Once measured, `imported` draws Chromium's conversion as it is and
 * `apple` with Apple's gamma undone, each through `undo` where Chromium took another matrix or
 * range; `read` keeps reading the planes back, as where nothing matched or Chromium would
 * convert the primaries or transfer.
 */
export interface Route {
  readonly stated: VideoColorSpaceInit;
  via: "unmeasured" | "imported" | "apple" | "read";
  tries: number;
  /**
   * The column-major 4×4 affine map from Chromium's R′G′B′, with Apple's gamma undone where
   * `apple`, to the stream's own.
   */
  readonly undo: Float32Array;
}

interface Measured {
  readonly stated: VideoColorSpaceInit;
  readonly depth: number;
  readonly undo: Float32Array;
}

// The matrices and ranges Chromium may take a stream's frames for instead of the stream's own:
// the two of SD and HD, in either range.
const ASSUMED: readonly VideoColorSpaceInit[] = [
  { matrix: "bt709", fullRange: false },
  { matrix: "bt709", fullRange: true },
  { matrix: "smpte170m", fullRange: false },
  { matrix: "smpte170m", fullRange: true },
];

// The primaries and transfers Chromium leaves as they are, as FFmpeg does, which converts neither:
// BT.709's primaries, and the transfers it treats as sRGB's (src/codec.ts). Measuring tells
// transfers and matrices apart, but not primaries, which only the most saturated colours show.
const KEPT_PRIMARIES = new Set<VideoColorPrimaries | null | undefined>([undefined, "bt709"]);
const KEPT_TRANSFERS = new Set<VideoTransferCharacteristics | null | undefined>([
  undefined,
  "bt709",
  "smpte170m",
  "iec61966-2-1",
]);

/**
 * The route of a stream whose colour is `stated`, before its frames are measured: read back if
 * Chromium converts its primaries or transfer, as HDR's.
 */
export function createRoute(stated: VideoColorSpaceInit): Route {
  const kept = KEPT_PRIMARIES.has(stated.primaries) && KEPT_TRANSFERS.has(stated.transfer);
  const undo = new Float32Array(16);
  identity(undo);
  return { stated, via: kept ? "unmeasured" : "read", tries: 0, undo };
}

const srgbDecode = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function quantile(sorted: Float32Array, q: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Infinity;
}

// Writes into `off`, for each midtone channel of the grid in `data` (laid out as `verdict` says),
// how far Chromium's conversion, Apple's gamma undone where `apple` and then mapped by `undo`, is
// from the compositor's. Returns how many it wrote.
function differences(data: Float32Array, apple: boolean, undo: Float32Array, off: Float32Array) {
  const read = GRID_HEIGHT * (GRID_ROW / 4);
  // Undone mirrored about 0, as the shader does, since Chromium's values may fall below 0.
  const encode = (v: number) => (apple ? Math.sign(v) * srgbDecode(Math.abs(v)) ** (1 / 1.961) : v);
  let count = 0;

  for (let i = 0; i < read; i += 4) {
    const r = encode(data[i] ?? 0);
    const g = encode(data[i + 1] ?? 0);
    const b = encode(data[i + 2] ?? 0);

    // Alpha is left out.
    for (let c = 0; c < 3; c++) {
      const truth = data[read + i + c] ?? 0;
      if (truth < MIDTONES[0] || truth > MIDTONES[1]) continue;
      const mapped =
        (undo[c] ?? 0) * r + (undo[4 + c] ?? 0) * g + (undo[8 + c] ?? 0) * b + (undo[12 + c] ?? 0);
      off[count++] = Math.abs(mapped - truth);
    }
  }

  return count;
}

/**
 * Decides how a stream goes up from a grid read back into `data`: Chromium's conversion of each
 * point, then the compositor's, in rows of GRID_ROW bytes. `off` is scratch space for a
 * difference per channel. Returns undefined, undecided, while too few channels are midtones or
 * too few points coloured. Chromium's conversion is tried as it is, then, where it is unclipped,
 * through each matrix and range it may have taken instead of `stream.stated`, each with and
 * without Apple's gamma undone; the first that matches is left in `stream.undo`, and `read` is
 * returned if none does. A frame that matches neither way as it is, and whose conversion does not
 * go past both 0 and 1, is undecided too, as a later, more saturated one may show the matrix.
 */
export function verdict(
  data: Float32Array,
  off: Float32Array,
  stream: Measured,
): Route["via"] | undefined {
  const { stated, depth, undo } = stream;
  const read = GRID_HEIGHT * (GRID_ROW / 4);
  let coloured = 0;
  let below = 0;
  let above = 0;

  for (let i = 0; i < read; i += 4) {
    const [r = 0, g = 0, b = 0] = data.subarray(read + i, read + i + 3);
    if (Math.max(r, g, b) - Math.min(r, g, b) > COLOURED) coloured++;

    for (let c = i; c < i + 3; c++) {
      const imported = data[c] ?? 0;
      if (imported < -BEYOND) below++;
      if (imported > 1 + BEYOND) above++;
    }
  }

  identity(undo);
  if (differences(data, false, undo, off) < MIN_POINTS || coloured < MIN_COLOURED) return undefined;

  const matches = (apple: boolean) => {
    const sorted = off.subarray(0, differences(data, apple, undo, off));
    // In place, as `differences` fills `off` afresh each time.
    sorted.sort();
    return quantile(sorted, 0.5) <= MEDIAN_OFF && quantile(sorted, 0.95) <= P95_OFF;
  };

  if (matches(false)) return "imported";
  if (matches(true)) return "apple";

  if (below < BEYOND_POINTS || above < BEYOND_POINTS) return undefined;

  for (const assumed of ASSUMED) {
    undoMatrix(undo, stated, assumed, depth);
    if (matches(false)) return "imported";
    if (matches(true)) return "apple";
  }

  identity(undo);
  return "read";
}

interface MeasureGpu {
  readonly device: GPUDevice;
  readonly pipeline: GPURenderPipeline;
  readonly sampler: GPUSampler;
}

// The bind group that draws `frame` both ways: from its planes uploaded into `picture`, and as
// Chromium converts it.
function bindMeasure(gpu: MeasureGpu, frame: VideoFrame, picture: Slot) {
  const colourBuffer = picture.colour;
  if (!colourBuffer) throw new Error("a measured picture without a colour");
  const [y, u, v] = planeViews(picture.textures);
  return gpu.device.createBindGroup({
    layout: gpu.pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 1, resource: y },
      { binding: 2, resource: u },
      { binding: 3, resource: v },
      { binding: 4, resource: { buffer: colourBuffer } },
      { binding: 5, resource: gpu.device.importExternalTexture({ source: frame }) },
      { binding: 6, resource: gpu.sampler },
    ],
  });
}

// Draws the grid with `bindGroup` into `targets`, and copies both into `buffer` to read back.
function drawGrid(
  gpu: MeasureGpu,
  bindGroup: GPUBindGroup,
  targets: readonly GPUTexture[],
  buffer: GPUBuffer,
) {
  const encoder = gpu.device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: targets.map((t) => ({
      view: t.createView(),
      loadOp: "clear" as const,
      storeOp: "store" as const,
    })),
  });
  pass.setPipeline(gpu.pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();

  for (const [i, t] of targets.entries()) {
    const at = { buffer, offset: i * GRID_HEIGHT * GRID_ROW, bytesPerRow: GRID_ROW };
    // readback: a small grid, of up to MAX_TRIES frames per stream, until they decide the route.
    encoder.copyTextureToBuffer({ texture: t }, at, [GRID_WIDTH, GRID_HEIGHT]);
  }

  gpu.device.queue.submit([encoder.finish()]);
}

/** Measures one frame at a time, of any stream, into textures and a buffer made at the first. */
export function createMeasurer(gpu: MeasureGpu) {
  const measuring = {
    busy: false,
    targets: undefined as [GPUTexture, GPUTexture] | undefined,
    buffer: undefined as GPUBuffer | undefined,
    // Scratch space for `verdict`: a difference for each channel of the grid.
    off: new Float32Array(GRID_WIDTH * GRID_HEIGHT * 3),
    // Resolved as the measurement under way ends, for the tests.
    done: Promise.withResolvers<void>(),
  };
  // None is under way at first.
  measuring.done.resolve();

  // Decides `route` from `frame`'s grid, or leaves it for a later frame, up to MAX_TRIES. A
  // measurement that fails reads the planes from then on.
  async function measure(frame: VideoFrame, picture: Slot, route: Route, depth: number) {
    measuring.busy = true;
    route.tries++;

    try {
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
      const grid = () =>
        gpu.device.createTexture({ format: MEASURED, size: [GRID_WIDTH, GRID_HEIGHT], usage });
      measuring.targets ??= [grid(), grid()];
      const size = 2 * GRID_HEIGHT * GRID_ROW;
      const mapped = GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST;
      measuring.buffer ??= gpu.device.createBuffer({ size, usage: mapped });
      const { targets, buffer } = measuring;
      drawGrid(gpu, bindMeasure(gpu, frame, picture), targets, buffer);
      // readback: the grid above, compared on the CPU.
      await buffer.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(buffer.getMappedRange());
      const via = verdict(data, measuring.off, { stated: route.stated, depth, undo: route.undo });
      buffer.unmap();
      if (via) route.via = via;
      else if (route.tries >= MAX_TRIES) route.via = "read";
    } catch {
      route.via = "read";
    } finally {
      measuring.busy = false;
      measuring.done.resolve();
    }
  }

  return {
    /** Whether no measurement is under way, so another may start. */
    idle: () => !measuring.busy,
    /** Starts measuring `frame`, whose planes are uploaded into `picture`, for `route`. */
    start(frame: VideoFrame, picture: Slot, route: Route, depth: number) {
      measuring.done = Promise.withResolvers<void>();
      void measure(frame, picture, route, depth);
    },
    /** Resolves once the last measurement started has ended. */
    done: () => measuring.done.promise,
  };
}

export type Measurer = ReturnType<typeof createMeasurer>;

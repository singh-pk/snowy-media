// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// How a stream's frames go up, measured on its own frames (docs/architecture.md#colour): a
// frame drawn both ways at a grid of points, by Chromium's conversion and from its planes, read
// back and compared, to tell whether Chromium converts it as FFmpeg does, with Apple's gamma, or
// through another matrix or range that can be undone.

import { identity, undoMatrix } from "./colour";
import { planeViews, type Slot } from "./pictures";
import { MEASURED } from "./shaders";

// The points a frame is measured at, both conversions of each read back in 32-bit floats, a row
// of them 2048 bytes, as a texture copy's rows are a multiple of 256 bytes.
const GRID_WIDTH = 128;
const GRID_HEIGHT = 72;
const GRID_ROW = GRID_WIDTH * 16;
// Of a measurement's channels, those neither near black nor near white tell the conversions
// apart, and in a sharp frame, as colour bars, they are only along its edges; with fewer than this, as in a dark frame, the next frame is measured.
const MIDTONES = [0.1, 0.9] as const;
const MIN_POINTS = 300;
// Of its points, those whose channels differ by more than this are coloured: only they tell a
// matrix apart, and a frame with fewer than MIN_COLOURED, near grey, is not measured either.
const COLOURED = 0.1;
const MIN_COLOURED = 400;
// The frames measured before giving up on a stream, as in a dark, grey or muted one, or one
// Chromium clips: its planes are read back from then on, as when there is no measurement.
const MAX_TRIES = 60;
// How far Chromium's conversion may be from this one's, at the median and the 95th percentile of
// the points: the two filter differently at edges, and Apple's gamma moves a midtone by 11 levels
// of 255.
const MEDIAN_OFF = 1.5 / 255;
const P95_OFF = 6 / 255;
// Undoing a matrix mixes the channels, so it needs Chromium's conversion unclipped: shown by at
// least BEYOND_POINTS of its channels further than BEYOND below 0, and as many above 1, as one
// clip may be at one end only. Where Chromium clips, as into an 8-bit texture, a saturated
// colour would not come back; a frame whose colours all fit shows nothing either way, so it
// decides nothing, and a later, more saturated frame is measured.
const BEYOND = 2 / 255;
const BEYOND_POINTS = 10;

/**
 * How a stream's frames whose planes can be read go up, worked out from its own frames
 * (docs/architecture.md#colour): read back and converted here until measured; then imported, as
 * Chromium converts them, as they are (`imported`) or with Apple's gamma undone (`apple`), and
 * through `undo` where Chromium took another matrix or range; or read back still where none of
 * these matches (`read`).
 */
export interface Route {
  readonly stated: VideoColorSpaceInit;
  via: "unmeasured" | "imported" | "apple" | "read";
  // The frames measured so far.
  tries: number;
  // From Chromium's R′G′B′, Apple's gamma undone where `apple`, to the stream's: column-major.
  readonly undo: Float32Array;
}

/** What a measurement decides for: the stream's stated colour, its planes' bit depth, and `undo`. */
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

// What Chromium converts as FFmpeg does, which converts neither primaries nor transfer: BT.709's
// primaries, and the transfers it takes for sRGB's, all a stream that states none is decoded as
// (src/codec.ts). Measuring tells a transfer and a matrix apart, but not primaries, which only
// the most saturated colours would.
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

// The value at fraction `q` of `sorted`.
function quantile(sorted: Float32Array, q: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Infinity;
}

// How far Chromium's conversion of the points in `data` (see verdict), Apple's gamma undone
// where `apple`, then mapped by `undo`, is from this one's: a difference for each midtone
// channel, in `off`. Returns how many.
function differences(data: Float32Array, apple: boolean, undo: Float32Array, off: Float32Array) {
  const read = GRID_HEIGHT * (GRID_ROW / 4);
  // Mirrored about 0, as the shader undoes it.
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
 * Which way a stream goes, from a grid read back (`data`): Chromium's conversion of each point,
 * then this one's, in rows of GRID_ROW bytes. Undecided while too few channels are midtones or
 * too few points coloured. Chromium's conversion is tried as it is, then, where it is unclipped,
 * through each matrix and range it may have taken instead of `stream.stated`, each with and
 * without Apple's gamma undone; the first that matches is written into `stream.undo`. A frame
 * that matches neither as it is, and whose conversion does not go past both 0 and 1, is
 * undecided too: a later, more saturated one may show the matrix.
 * `off` holds a difference for each channel.
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

/** What a measurement draws with. */
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
    // A difference for each channel of the grid.
    off: new Float32Array(GRID_WIDTH * GRID_HEIGHT * 3),
    // Resolved as the measurement under way ends, for the tests.
    done: Promise.withResolvers<void>(),
  };
  // None is under way at first.
  measuring.done.resolve();

  // Converts the points of the grid of `frame` both ways, from its planes uploaded into `picture`
  // and as Chromium converts it, and decides `route` by them, or leaves it for a later frame,
  // up to MAX_TRIES. A measurement that fails reads the planes from then on. The planes are
  // `depth`-bit.
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

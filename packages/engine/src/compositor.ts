// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The WebGPU compositor. A decoded frame is uploaded into textures of its own, a picture, and
// closed: a VideoFrame's planes copied out first, FFmpeg's straight from its shared memory;
// a picture is drawn into the canvas, rotated and flipped as the stream's display matrix says,
// scaled to fit and centred, with black around it. A frame whose planes can be read is
// converted to RGB here, with its own matrix and range, so every decoder's frames look the same
// and keep every bit; one whose planes cannot (a 10-bit hardware frame) is converted by
// Chromium, as an external texture (docs/architecture.md#colour).

import type { DecodedFrame } from "./wasm-video";

const VERTEX = /* wgsl */ `
struct View {
  // From the canvas's clip space to the picture's texture coordinates.
  map: mat2x2f,
  offset: vec2f,
}

struct Vertex {
  @builtin(position) position: vec4f,
  @location(0) clip: vec2f,
}

// One triangle that covers the target.
@vertex fn vs(@builtin(vertex_index) i: u32) -> Vertex {
  let clip = vec2f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0);
  return Vertex(vec4f(clip, 0.0, 1.0), clip);
}

const BLACK = vec4f(0.0, 0.0, 0.0, 1.0);

fn inside(uv: vec2f) -> bool {
  return all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
}
`;

// Y′CbCr planes, read exactly as integers and filtered here: 16-bit textures cannot be
// filtered, or even made, without an optional feature.
const PLANES = /* wgsl */ `
struct Colour {
  // From the planes' integer values (Y, Cb, Cr, 1) to R′G′B′.
  yuv: mat4x4f,
  // Whether Cb and Cr share one plane (NV12), as its red and green.
  interleaved: u32,
}

@group(0) @binding(1) var luma: texture_2d<u32>;
@group(0) @binding(2) var cb: texture_2d<u32>;
@group(0) @binding(3) var cr: texture_2d<u32>;
@group(0) @binding(4) var<uniform> colour: Colour;

// Plane \`t\` at \`uv\`, filtered bilinearly between its four nearest samples.
fn bilinear(t: texture_2d<u32>, uv: vec2f) -> vec2f {
  let size = vec2i(textureDimensions(t));
  let pos = uv * vec2f(size) - 0.5;
  let base = floor(pos);
  let f = pos - base;
  let lo = clamp(vec2i(base), vec2i(0), size - 1);
  let hi = clamp(vec2i(base) + 1, vec2i(0), size - 1);
  let a = vec2f(textureLoad(t, lo, 0).rg);
  let b = vec2f(textureLoad(t, vec2i(hi.x, lo.y), 0).rg);
  let c = vec2f(textureLoad(t, vec2i(lo.x, hi.y), 0).rg);
  let d = vec2f(textureLoad(t, hi, 0).rg);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// The planes' R′G′B′ at \`uv\`.
fn convert(uv: vec2f) -> vec3f {
  let y = bilinear(luma, uv).r;
  let blue = bilinear(cb, uv);
  let red = select(bilinear(cr, uv).r, blue.g, colour.interleaved == 1u);
  let rgb = (colour.yuv * vec4f(y, blue.r, red, 1.0)).rgb;
  return clamp(rgb, vec3f(0.0), vec3f(1.0));
}
`;

const YUV_SHADER = /* wgsl */ `${VERTEX}
@group(0) @binding(0) var<uniform> view: View;
${PLANES}
@fragment fn fs(@location(0) clip: vec2f) -> @location(0) vec4f {
  let uv = view.map * clip + view.offset;
  return select(BLACK, vec4f(convert(uv), 1.0), inside(uv));
}
`;

// A picture already in RGB: an RGB frame, or one Chromium converted.
const RGB_SHADER = /* wgsl */ `${VERTEX}
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var picture: texture_2d<f32>;
@group(0) @binding(2) var linear: sampler;

@fragment fn fs(@location(0) clip: vec2f) -> @location(0) vec4f {
  let uv = view.map * clip + view.offset;
  let color = textureSampleLevel(picture, linear, uv, 0.0);
  return select(BLACK, vec4f(color.rgb, 1.0), inside(uv));
}
`;

// A frame converted by Chromium into a picture of its size. Where Chromium took it for Apple's
// BT.709, a gamma of 1.961, and encoded it as sRGB (`apple`), that is undone; and where it took
// another matrix or range than the stream's, `undo` takes its R′G′B′ back through its matrix to
// the planes and on through the stream's, leaving the frame's R′G′B′ (docs/architecture.md#colour).
const IMPORT_SHADER = /* wgsl */ `${VERTEX}
@group(0) @binding(0) var frame: texture_external;
@group(0) @binding(1) var linear: sampler;
@group(0) @binding(2) var<uniform> undo: mat4x4f;
override apple = false;

fn srgbDecode(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

@fragment fn fs(@location(0) clip: vec2f) -> @location(0) vec4f {
  let uv = clip * vec2f(0.5, -0.5) + 0.5;
  let rgb = textureSampleBaseClampToEdge(frame, linear, uv).rgb;
  // Mirrored about 0, as Chromium encodes a value below 0: the matrix after mixes the channels.
  let undone = sign(rgb) * pow(srgbDecode(abs(rgb)), vec3f(1.0 / 1.961));
  let encoded = select(rgb, undone, apple);
  return vec4f((undo * vec4f(encoded, 1.0)).rgb, 1.0);
}
`;

// The same points of a frame converted both ways, by Chromium and here, to compare.
const MEASURE_SHADER = /* wgsl */ `${VERTEX}
${PLANES}
@group(0) @binding(5) var frame: texture_external;
@group(0) @binding(6) var linear: sampler;

struct Measured {
  @location(0) imported: vec4f,
  @location(1) read: vec4f,
}

@fragment fn fs(@location(0) clip: vec2f) -> Measured {
  // At the centre of the frame's nearest pixel, as both conversions sample alike there: between
  // pixels, at an edge, they filter differently.
  let size = vec2f(textureDimensions(luma));
  let uv = (floor((clip * vec2f(0.5, -0.5) + 0.5) * size) + 0.5) / size;
  let imported = textureSampleBaseClampToEdge(frame, linear, uv).rgb;
  return Measured(vec4f(imported, 1.0), vec4f(convert(uv), 1.0));
}
`;

// What a picture converted by Chromium is stored as: 10 bits a channel, 4 bytes a pixel.
const IMPORTED: GPUTextureFormat = "rgb10a2unorm";

// The points a frame is measured at, both conversions of each read back in 32-bit floats, a row
// of them 2048 bytes, as a texture copy's rows are a multiple of 256 bytes.
const GRID_WIDTH = 128;
const GRID_HEIGHT = 72;
const MEASURED: GPUTextureFormat = "rgba32float";
const GRID_ROW = GRID_WIDTH * 16;
// Of a measurement's channels, those neither near black nor near white tell the conversions
// apart, and in a sharp frame, as colour bars, they are only along its edges; with fewer than this, as in a dark frame, the next frame is measured.
const MIDTONES = [0.1, 0.9] as const;
const MIN_POINTS = 300;
// Of its points, those whose channels differ by more than this are coloured: only they tell a
// matrix apart, and a frame with fewer than MIN_COLOURED, near grey, is not measured either.
const COLOURED = 0.1;
const MIN_COLOURED = 400;
// The frames measured before giving up on a stream, as in a dark or grey one: its planes are
// read, as before.
const MAX_TRIES = 60;
// How far Chromium's conversion may be from this one's, at the median and the 95th percentile of
// the points: the two filter differently at edges, and Apple's gamma moves a midtone by 11 levels
// of 255.
const MEDIAN_OFF = 1.5 / 255;
const P95_OFF = 6 / 255;
// Undoing a matrix mixes the channels, so it needs Chromium's conversion unclipped: shown by at
// least BEYOND_POINTS of its channels further than BEYOND below 0, and as many above 1, as one
// clip may be at one end only. Where Chromium clips, as into an 8-bit texture, a saturated
// colour would not come back; a frame whose colours all fit shows nothing either way.
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

// Makes `out` the 4 × 4 identity.
function identity(out: Float32Array) {
  out.fill(0);
  for (let i = 0; i < 4; i++) out[i * 5] = 1;
}

/**
 * Writes into `out` the map from R′G′B′ as Chromium converts `depth`-bit planes it takes for
 * `assumed` to R′G′B′ as the stream states, `stated`: back through the one matrix to the planes,
 * and on through the other. Both are affine, so the map is too.
 */
export function undoMatrix(
  out: Float32Array,
  stated: VideoColorSpaceInit,
  assumed: VideoColorSpaceInit,
  depth: number,
) {
  const to = new Float32Array(16);
  const from = new Float32Array(16);
  yuvMatrix(to, stated, depth);
  yuvMatrix(from, assumed, depth);
  // Column-major: row r, column c at c * 4 + r.
  const m = (r: number, c: number) => from[c * 4 + r] ?? 0;
  const det =
    m(0, 0) * (m(1, 1) * m(2, 2) - m(1, 2) * m(2, 1)) -
    m(0, 1) * (m(1, 0) * m(2, 2) - m(1, 2) * m(2, 0)) +
    m(0, 2) * (m(1, 0) * m(2, 1) - m(1, 1) * m(2, 0));
  // The inverse of `from`'s 3 × 3, then its offset.
  const inverse = new Float32Array(16);
  inverse.set([
    (m(1, 1) * m(2, 2) - m(1, 2) * m(2, 1)) / det,
    (m(1, 2) * m(2, 0) - m(1, 0) * m(2, 2)) / det,
    (m(1, 0) * m(2, 1) - m(1, 1) * m(2, 0)) / det,
    0,
    (m(0, 2) * m(2, 1) - m(0, 1) * m(2, 2)) / det,
    (m(0, 0) * m(2, 2) - m(0, 2) * m(2, 0)) / det,
    (m(0, 1) * m(2, 0) - m(0, 0) * m(2, 1)) / det,
    0,
    (m(0, 1) * m(1, 2) - m(0, 2) * m(1, 1)) / det,
    (m(0, 2) * m(1, 0) - m(0, 0) * m(1, 2)) / det,
    (m(0, 0) * m(1, 1) - m(0, 1) * m(1, 0)) / det,
    0,
  ]);

  for (let r = 0; r < 3; r++) {
    inverse[12 + r] = -(
      (inverse[r] ?? 0) * m(0, 3) +
      (inverse[4 + r] ?? 0) * m(1, 3) +
      (inverse[8 + r] ?? 0) * m(2, 3)
    );
  }

  inverse[15] = 1;

  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (to[k * 4 + r] ?? 0) * (inverse[c * 4 + k] ?? 0);
      out[c * 4 + r] = sum;
    }
  }
}

const srgbDecode = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// The value at fraction `q` of the first `count` of `values`.
function quantile(values: Float32Array, count: number, q: number) {
  const sorted = values.subarray(0, count).toSorted();
  return sorted[Math.min(count - 1, Math.floor(q * count))] ?? Infinity;
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
 * Which way a stream whose colour is `stated`, of `depth`-bit planes, goes, from a grid read
 * back (`data`): Chromium's conversion of each point, then this one's, in rows of GRID_ROW bytes.
 * Undecided while too few channels are midtones or too few points coloured. Chromium's
 * conversion is tried as it is, then, where it is unclipped, through each matrix and range it may
 * have taken instead, each with and without Apple's gamma undone; the first that matches is
 * written into `undo`.
 * `off` holds a difference for each channel.
 */
export function verdict(
  data: Float32Array,
  off: Float32Array,
  stated: VideoColorSpaceInit,
  depth: number,
  undo: Float32Array,
): Route["via"] | undefined {
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
    const count = differences(data, apple, undo, off);
    return quantile(off, count, 0.5) <= MEDIAN_OFF && quantile(off, count, 0.95) <= P95_OFF;
  };

  if (matches(false)) return "imported";
  if (matches(true)) return "apple";

  if (below >= BEYOND_POINTS && above >= BEYOND_POINTS) {
    for (const assumed of ASSUMED) {
      undoMatrix(undo, stated, assumed, depth);
      if (matches(false)) return "imported";
      if (matches(true)) return "apple";
    }
  }

  identity(undo);
  return "read";
}

// FFmpeg's identity display matrix: 16.16 fixed point, and 2.30 in the last column.
const IDENTITY = [65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30];

// Kr and Kb of each matrix (ITU-T H.273); the others are RGB or unknown.
const LUMA: Record<string, [number, number]> = {
  bt709: [0.2126, 0.0722],
  bt470bg: [0.299, 0.114],
  smpte170m: [0.299, 0.114],
  "bt2020-ncl": [0.2627, 0.0593],
};

/**
 * Writes into `out` the map from clip space to texture coordinates (a column-major 2×2, then
 * the offset) that shows a `width` × `height` frame transformed by display matrix `matrix`,
 * fitted into a `canvasWidth` × `canvasHeight` canvas. FFmpeg's matrix takes a point (x, y)
 * of the frame, y down, to (a x + c y, b x + d y) on the display, where a, b, c, d are its
 * entries 0, 1, 3 and 4 (libavutil/display.h).
 */
export function viewMap(
  out: Float32Array,
  matrix: readonly number[],
  width: number,
  height: number,
  canvasWidth: number,
  canvasHeight: number,
) {
  const [a = 1, b = 0, , c = 0, d = 1] = matrix;
  const det = a * d - b * c;
  // A matrix that collapses the frame is no transform at all.
  if (det === 0) return viewMap(out, IDENTITY, width, height, canvasWidth, canvasHeight);

  // The display's size, the frame's corners transformed, and the scale that fits it in.
  const displayWidth = Math.abs(a) * width + Math.abs(c) * height;
  const displayHeight = Math.abs(b) * width + Math.abs(d) * height;
  const fit = Math.min(canvasWidth / displayWidth, canvasHeight / displayHeight);
  // Clip space to display pixels from the centre, y down.
  const sx = canvasWidth / (2 * fit);
  const sy = -canvasHeight / (2 * fit);
  // Then by the inverse matrix to frame pixels from the centre, then to texture coordinates.
  out[0] = (d / det / width) * sx;
  out[1] = (-b / det / height) * sx;
  out[2] = (-c / det / width) * sy;
  out[3] = (a / det / height) * sy;
  out[4] = 0.5;
  out[5] = 0.5;
}

/**
 * Writes into `out` the column-major 4×4 matrix that takes a pixel's `depth`-bit plane values
 * (Y, Cb, Cr, 1) to R′G′B′, by the colour space `space` states. A stream that states no
 * matrix is BT.601, and one that states no range limited, as FFmpeg takes them. For RGB
 * (the planes G, B, R), the planes are R′G′B′ already, scaled by the range: full unless it
 * states limited.
 */
export function yuvMatrix(out: Float32Array, space: VideoColorSpaceInit, depth: number) {
  const max = 2 ** depth - 1;
  const scale = 2 ** (depth - 8);
  // y′ = ys Y + yo, and c′ = cs C + co, from -0.5 to 0.5.
  const [ys, yo, cs, co] = space.fullRange
    ? [1 / max, 0, 1 / max, -(2 ** (depth - 1)) / max]
    : [1 / (219 * scale), -16 / 219, 1 / (224 * scale), -128 / 224];
  out.fill(0);
  out[15] = 1;

  if (space.matrix === "rgb") {
    // RGB is full range unless it states otherwise, as FFmpeg takes it.
    const [s, o] = space.fullRange === false ? [ys, yo] : [1 / max, 0];
    out.set([0, s, 0], 0);
    out.set([0, 0, s], 4);
    out.set([s, 0, 0], 8);
    out.set([o, o, o], 12);
    return;
  }

  const [kr, kb] = LUMA[space.matrix ?? "bt470bg"] ?? [0.299, 0.114];
  const kg = 1 - kr - kb;
  // R = y′ + vr c′r, G = y′ - ub c′b - vr2 c′r, B = y′ + ub2 c′b.
  const vr = 2 * (1 - kr);
  const ub2 = 2 * (1 - kb);
  const ug = (ub2 * kb) / kg;
  const vg = (vr * kr) / kg;
  out.set([ys, ys, ys], 0);
  out.set([0, -ug * cs, ub2 * cs], 4);
  out.set([vr * cs, -vg * cs, 0], 8);
  out.set([yo + vr * co, yo - (ug + vg) * co, yo + ub2 * co], 12);
}

// How a frame of `format` is uploaded: the texture format and size of each plane used, its
// bit depth, and whether it is Y′CbCr. An alpha plane is left out: the canvas is opaque.
function planesOf(
  format: VideoPixelFormat,
  width: number,
  height: number,
): { yuv: boolean; depth: number; planes: [GPUTextureFormat, number, number][] } {
  const half = [(width + 1) >> 1, (height + 1) >> 1] as const;

  if (format === "NV12") {
    return {
      yuv: true,
      depth: 8,
      planes: [
        ["r8uint", width, height],
        ["rg8uint", ...half],
      ],
    };
  }

  if (format === "RGBA" || format === "RGBX") {
    return { yuv: false, depth: 8, planes: [["rgba8unorm", width, height]] };
  }

  if (format === "BGRA" || format === "BGRX") {
    return { yuv: false, depth: 8, planes: [["bgra8unorm", width, height]] };
  }

  const depth = format.includes("P12") ? 12 : format.includes("P10") ? 10 : 8;
  const sample = depth > 8 ? "r16uint" : "r8uint";
  const [cw, ch] = format.startsWith("I420")
    ? half
    : format.startsWith("I422")
      ? [half[0], height]
      : [width, height];
  return {
    yuv: true,
    depth,
    planes: [
      [sample, width, height],
      [sample, cw, ch],
      [sample, cw, ch],
    ],
  };
}

/** A frame uploaded to the GPU, which the compositor draws. */
export interface Picture {
  /** The presentation time, in microseconds. */
  timestamp: number;
  /** Its size as shown, before rotation. */
  displayWidth: number;
  displayHeight: number;
  readonly yuv: boolean;
  readonly bindGroup: GPUBindGroup;
  /** Gives its textures back, for the next frame of its size and format. */
  close(): void;
}

interface Slot extends Picture {
  readonly key: string;
  readonly textures: GPUTexture[];
  readonly colour: GPUBuffer | undefined;
  // The view of a picture Chromium converts into, made once.
  readonly imported: GPUTextureView | undefined;
  // Where each plane is written, made once.
  readonly destinations: { texture: GPUTexture }[];
}

// The size of the part of `frame` that is shown.
// FFmpeg's frames are their visible part.
const visibleWidth = (frame: DecodedFrame) =>
  frame instanceof VideoFrame ? (frame.visibleRect?.width ?? frame.codedWidth) : frame.codedWidth;
const visibleHeight = (frame: DecodedFrame) =>
  frame instanceof VideoFrame
    ? (frame.visibleRect?.height ?? frame.codedHeight)
    : frame.codedHeight;

// The views of a Y′CbCr picture's planes Y, Cb and Cr: NV12 has Cb and Cr in one.
function planeViews(textures: GPUTexture[]) {
  const views = textures.map((t) => t.createView());
  const y = views[0];
  if (!y) throw new Error("a picture without planes");
  const u = views[1] ?? y;
  return [y, u, views[2] ?? u] as const;
}

/** A compositor drawing with `device` into `context`, configured for it with `format`. */
export function createCompositor(
  device: GPUDevice,
  context: GPUCanvasContext,
  format: GPUTextureFormat,
) {
  const pipeline = (code: string, outputs: GPUTextureFormat[], constants = {}) => {
    const module = device.createShaderModule({ code });
    const targets = outputs.map((output) => ({ format: output }));
    return device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets, constants },
      primitive: { topology: "triangle-list" },
    });
  };

  const yuvPipeline = pipeline(YUV_SHADER, [format]);
  const rgbPipeline = pipeline(RGB_SHADER, [format]);
  const importPipeline = pipeline(IMPORT_SHADER, [IMPORTED]);
  const applePipeline = pipeline(IMPORT_SHADER, [IMPORTED], { apple: 1 });
  const measurePipeline = pipeline(MEASURE_SHADER, [MEASURED, MEASURED]);
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  // The import's `undo`, written before each frame imported.
  const undoBuffer = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // mat2x2f, then vec2f, padded to 32 bytes.
  const view = new Float32Array(8);
  const viewBuffer = device.createBuffer({
    size: view.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // mat4x4f, then u32, padded to 80 bytes.
  const colour = new Float32Array(20);
  const colourWords = new Uint32Array(colour.buffer);
  // Where a frame's planes are copied on their way to the GPU, grown as frames need.
  const staging = { buffer: new ArrayBuffer(0) };
  // Pictures closed, by size and format, for the next frames; and the last upload, which the
  // next waits for, as they share `staging`.
  const free = new Map<string, Slot[]>();
  const uploads = { last: Promise.resolve() };
  // The kind and size of the frames uploaded last, and what follows from them, worked out
  // again only when they change, so a frame allocates none of it.
  const shape = {
    kind: "",
    width: 0,
    height: 0,
    key: "",
    planes: undefined as ReturnType<typeof planesOf> | undefined,
  };
  // What `colour` was last worked out for, so it is worked out again only when that changes.
  const converted = { space: undefined as VideoColorSpaceInit | undefined, depth: 0, pixels: "" };
  // Where a plane is read from in `staging`, filled in for each.
  const source = { offset: 0, bytesPerRow: 0 };
  // One measurement at a time, of any stream, into textures and a buffer made at the first.
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

  function keyOf(kind: string, width: number, height: number) {
    if (kind === shape.kind && width === shape.width && height === shape.height) return shape.key;
    Object.assign(shape, {
      kind,
      width,
      height,
      key: `${kind}:${width}x${height}`,
      planes: undefined,
    });
    return shape.key;
  }

  // A picture of `key` from those closed, or `make`'s. Those of another key are destroyed:
  // a stream's frames keep one size and format, so they are of a stream before.
  function acquire(key: string, make: () => Slot) {
    for (const [other, slots] of free) {
      if (other === key) continue;

      for (const slot of slots) {
        for (const texture of slot.textures) texture.destroy();
        slot.colour?.destroy();
      }

      free.delete(other);
    }

    return free.get(key)?.pop() ?? make();
  }

  function makeSlot(
    key: string,
    textures: GPUTexture[],
    bindGroup: GPUBindGroup,
    colourBuffer?: GPUBuffer,
    imported?: GPUTextureView,
  ): Slot {
    const picture: Slot = {
      key,
      textures,
      destinations: textures.map((t) => ({ texture: t })),
      colour: colourBuffer,
      imported,
      bindGroup,
      yuv: colourBuffer !== undefined,
      timestamp: 0,
      displayWidth: 0,
      displayHeight: 0,
      close() {
        const slots = free.get(key);
        if (slots) slots.push(picture);
        else free.set(key, [picture]);
      },
    };
    return picture;
  }

  const texture = (fmt: GPUTextureFormat, width: number, height: number, usage: number) =>
    device.createTexture({ format: fmt, size: [width, height], usage });

  // Converts the points of the grid of `frame` both ways, from its planes uploaded into `picture`
  // and as Chromium converts it, and decides `route` by them, or leaves it for a later frame,
  // up to MAX_TRIES. A measurement that fails reads the planes from then on. The planes are
  // `depth`-bit.
  async function measure(frame: VideoFrame, picture: Slot, route: Route, depth: number) {
    measuring.busy = true;
    route.tries++;

    try {
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
      const grid = () => texture(MEASURED, GRID_WIDTH, GRID_HEIGHT, usage);
      measuring.targets ??= [grid(), grid()];
      const size = 2 * GRID_HEIGHT * GRID_ROW;
      const mapped = GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST;
      measuring.buffer ??= device.createBuffer({ size, usage: mapped });
      const { targets, buffer } = measuring;
      const colourBuffer = picture.colour;
      if (!colourBuffer) throw new Error("a measured picture without a colour");
      const [y, u, v] = planeViews(picture.textures);
      const bindGroup = device.createBindGroup({
        layout: measurePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 1, resource: y },
          { binding: 2, resource: u },
          { binding: 3, resource: v },
          { binding: 4, resource: { buffer: colourBuffer } },
          { binding: 5, resource: device.importExternalTexture({ source: frame }) },
          { binding: 6, resource: sampler },
        ],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: targets.map((t) => ({
          view: t.createView(),
          loadOp: "clear" as const,
          storeOp: "store" as const,
        })),
      });
      pass.setPipeline(measurePipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();

      for (const [i, t] of targets.entries()) {
        const at = { buffer, offset: i * GRID_HEIGHT * GRID_ROW, bytesPerRow: GRID_ROW };
        encoder.copyTextureToBuffer({ texture: t }, at, [GRID_WIDTH, GRID_HEIGHT]);
      }

      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const via = verdict(
        new Float32Array(buffer.getMappedRange()),
        measuring.off,
        route.stated,
        depth,
        route.undo,
      );
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

  // Where the planes of `frame` are: a VideoFrame's copied out into the staging buffer first.
  async function readPlanes(frame: DecodedFrame) {
    if (!(frame instanceof VideoFrame)) return { data: frame.memory.buffer, layout: frame.layout };
    const size = frame.allocationSize();
    if (size > staging.buffer.byteLength) staging.buffer = new ArrayBuffer(size);
    const layout = await frame.copyTo(staging.buffer);
    return { data: staging.buffer, layout };
  }

  // Writes the planes of `frame`, which has a format, into a picture, and converts them when
  // drawn, by the colour `route` states; and measures a Y′CbCr VideoFrame while its stream is
  // unmeasured.
  async function uploadPlanes(frame: DecodedFrame, route: Route) {
    const { stated } = route;
    const pixels = frame.format;
    if (!pixels) throw new Error("a frame without a format has no planes to read");
    const width = visibleWidth(frame);
    const height = visibleHeight(frame);
    const { data, layout } = await readPlanes(frame);
    const key = keyOf(pixels, width, height);
    shape.planes ??= planesOf(pixels, width, height);
    const { yuv, depth, planes } = shape.planes;
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;

    const picture = acquire(key, () => {
      const textures = planes.map(([fmt, w, h]) => texture(fmt, w, h, usage));
      const [y, u, v] = planeViews(textures);

      if (!yuv) {
        const bindGroup = device.createBindGroup({
          layout: rgbPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: viewBuffer } },
            { binding: 1, resource: y },
            { binding: 2, resource: sampler },
          ],
        });
        return makeSlot(key, textures, bindGroup);
      }

      const colourBuffer = device.createBuffer({
        size: colour.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const bindGroup = device.createBindGroup({
        layout: yuvPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: viewBuffer } },
          { binding: 1, resource: y },
          { binding: 2, resource: u },
          { binding: 3, resource: v },
          { binding: 4, resource: { buffer: colourBuffer } },
        ],
      });
      return makeSlot(key, textures, bindGroup, colourBuffer);
    });

    // Indexed: an iterator would allocate on every frame.
    for (let i = 0; i < picture.destinations.length; i++) {
      const plane = layout[i];
      const destination = picture.destinations[i];
      if (!plane || !destination) throw new Error(`${pixels}: no plane ${i}`);
      source.offset = plane.offset;
      source.bytesPerRow = plane.stride;
      device.queue.writeTexture(destination, data, source, destination.texture);
    }

    if (picture.colour) {
      if (stated !== converted.space || depth !== converted.depth || pixels !== converted.pixels) {
        yuvMatrix(colour, stated, depth);
        colourWords[16] = pixels === "NV12" ? 1 : 0;
        Object.assign(converted, { space: stated, depth, pixels });
      }

      device.queue.writeBuffer(picture.colour, 0, colour);
      const unmeasured = route.via === "unmeasured" && !measuring.busy;

      if (unmeasured && frame instanceof VideoFrame) {
        measuring.done = Promise.withResolvers<void>();
        void measure(frame, picture, route, depth);
      }
    }

    return picture;
  }

  // Converts `frame` into a picture with Chromium's conversion, undoing Apple's gamma (`apple`)
  // and then mapping it by `undo`.
  function uploadImported(frame: VideoFrame, apple: boolean, undo: Float32Array) {
    const width = visibleWidth(frame);
    const height = visibleHeight(frame);
    const key = keyOf(IMPORTED, width, height);
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;

    const picture = acquire(key, () => {
      const picked = texture(IMPORTED, width, height, usage);
      const imported = picked.createView();
      const bindGroup = device.createBindGroup({
        layout: rgbPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: viewBuffer } },
          { binding: 1, resource: imported },
          { binding: 2, resource: sampler },
        ],
      });
      return makeSlot(key, [picked], bindGroup, undefined, imported);
    });

    const into = picture.imported;
    if (!into) throw new Error("no picture texture");
    // Each pipeline has a layout of its own.
    const converting = apple ? applePipeline : importPipeline;
    // An external texture lasts one task, so it needs a bind group of its own.
    const bindGroup = device.createBindGroup({
      layout: converting.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: device.importExternalTexture({ source: frame }) },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: undoBuffer } },
      ],
    });
    device.queue.writeBuffer(undoBuffer, 0, undo);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: into, loadOp: "clear", storeOp: "store" }],
    });
    pass.setPipeline(converting);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    return picture;
  }

  /**
   * Uploads `frame`, which it takes and closes, into a picture, the way its stream's `route`
   * goes, converting it by the colour the stream states: a decoder fills in what the stream leaves
   * out its own way. A frame whose planes cannot be read (a 10-bit hardware frame) is imported.
   * Uploads complete in the order they are called.
   */
  async function upload(frame: DecodedFrame, route: Route): Promise<Picture> {
    const before = uploads.last;
    const done = Promise.withResolvers<void>();
    uploads.last = done.promise;

    try {
      await before;
      const imported = route.via === "imported" || route.via === "apple";
      const uploading =
        frame instanceof VideoFrame && (imported || !frame.format)
          ? uploadImported(frame, route.via === "apple", route.undo)
          : uploadPlanes(frame, route);
      const picture = await uploading;
      picture.timestamp = frame.timestamp;
      picture.displayWidth = frame.displayWidth;
      picture.displayHeight = frame.displayHeight;
      return picture;
    } finally {
      frame.close();
      done.resolve();
    }
  }

  // The canvas's next texture, cleared to black: around a frame, or with no frame at all.
  function target(): GPURenderPassColorAttachment {
    return {
      view: context.getCurrentTexture().createView(),
      loadOp: "clear",
      clearValue: [0, 0, 0, 1],
      storeOp: "store",
    };
  }

  /** Draws `picture`, transformed by display matrix `matrix`. The caller still owns it. */
  function draw(picture: Picture, matrix: readonly number[]) {
    const { width, height } = context.canvas;
    viewMap(view, matrix, picture.displayWidth, picture.displayHeight, width, height);
    device.queue.writeBuffer(viewBuffer, 0, view);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [target()] });
    pass.setPipeline(picture.yuv ? yuvPipeline : rgbPipeline);
    pass.setBindGroup(0, picture.bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  /** Clears the canvas to black. */
  function clear() {
    const encoder = device.createCommandEncoder();
    encoder.beginRenderPass({ colorAttachments: [target()] }).end();
    device.queue.submit([encoder.finish()]);
  }

  return {
    upload,
    draw,
    clear,
    /** Resolves once the last measurement started has ended, for the tests. */
    measured: () => measuring.done.promise,
  };
}

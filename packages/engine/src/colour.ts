// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The colour matrices of the compositor: from a frame's plane values to R′G′B′, as FFmpeg
// converts them, and from R′G′B′ as Chromium converted it back to the stream's own
// (docs/architecture.md#colour).

// Kr and Kb of each matrix (ITU-T H.273); the others are RGB or unknown.
const LUMA: Record<string, [number, number]> = {
  bt709: [0.2126, 0.0722],
  bt470bg: [0.299, 0.114],
  smpte170m: [0.299, 0.114],
  "bt2020-ncl": [0.2627, 0.0593],
};

/** Makes `out` the 4 × 4 identity. */
export function identity(out: Float32Array) {
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
  const inverse = affineInverse(from);

  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (to[k * 4 + r] ?? 0) * (inverse[c * 4 + k] ?? 0);
      out[c * 4 + r] = sum;
    }
  }
}

// The inverse of `from`, an affine column-major 4 × 4: the inverse of its 3 × 3, then its offset.
function affineInverse(from: Float32Array) {
  // Column-major: row r, column c at c * 4 + r.
  const m = (r: number, c: number) => from[c * 4 + r] ?? 0;
  const det =
    m(0, 0) * (m(1, 1) * m(2, 2) - m(1, 2) * m(2, 1)) -
    m(0, 1) * (m(1, 0) * m(2, 2) - m(1, 2) * m(2, 0)) +
    m(0, 2) * (m(1, 0) * m(2, 1) - m(1, 1) * m(2, 0));
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
  return inverse;
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

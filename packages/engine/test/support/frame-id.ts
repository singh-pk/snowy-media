// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The frame number burned into every test video (scripts/gen-fixtures.ts): a row of
// FRAME_ID_BITS squares of CELL × CELL pixels in the top-left corner, white for a 1 and black
// for a 0, least significant bit first. Squares this size survive every lossy codec and colour
// conversion in the fixtures, so a test can tell which frame is on screen from its pixels alone.

export const CELL = 16;
export const FRAME_ID_BITS = 16;
// The rows and columns of a brightness grid.
const GRID = 8;

/**
 * The frame number in `pixels`, rows `stride` bytes apart, `channels` bytes per pixel with
 * brightness in the first (a grey plane, or the red channel of RGBA).
 */
export function readFrameId(pixels: Uint8Array | Uint8ClampedArray, stride: number, channels = 1) {
  const row = (CELL >> 1) * stride;
  let id = 0;

  for (let bit = 0; bit < FRAME_ID_BITS; bit++) {
    const x = bit * CELL + (CELL >> 1);
    if ((pixels[row + x * channels] ?? 0) > 127) id |= 1 << bit;
  }

  return id;
}

/**
 * The mean brightness of each of GRID × GRID equal cells of a `width` × `height` picture,
 * row by row, rounded: a coarse picture that tells whether a frame is upright, rotated or
 * flipped, through any codec and colour conversion. `pixels` has `channels` bytes per
 * pixel, rows packed, with brightness at `offset` (green, in RGB or BGR).
 */
export function brightnessGrid(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  { channels, offset }: { channels: number; offset: number },
) {
  const sums = new Float64Array(GRID * GRID);
  const counts = new Float64Array(GRID * GRID);

  for (let y = 0; y < height; y++) {
    const row = Math.floor((y * GRID) / height) * GRID;

    for (let x = 0; x < width; x++) {
      const cell = row + Math.floor((x * GRID) / width);
      sums[cell] = (sums[cell] ?? 0) + (pixels[(y * width + x) * channels + offset] ?? 0);
      counts[cell] = (counts[cell] ?? 0) + 1;
    }
  }

  return Array.from(sums, (s, i) => Math.round(s / (counts[i] ?? 1)));
}

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Where the compositor draws a picture in the canvas (docs/architecture.md#video-output): turned
// by the stream's display matrix, scaled to fit and centred, as the uniform its shaders map clip
// space by.

// FFmpeg's identity display matrix: 16.16 fixed point, and 2.30 in the last column.
const IDENTITY = [65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30];

/** A frame's size as shown, before rotation. */
interface Shown {
  readonly displayWidth: number;
  readonly displayHeight: number;
}

interface Canvas {
  readonly width: number;
  readonly height: number;
}

/**
 * Writes into `out` the map from clip space to texture coordinates (a column-major 2×2, then
 * the offset) that shows a `frame` transformed by display matrix `matrix`, fitted into `canvas`.
 * FFmpeg's matrix takes a point (x, y) of the frame, y down, to (a x + c y, b x + d y) on the
 * display, where a, b, c, d are its entries 0, 1, 3 and 4 (libavutil/display.h). Called on every
 * frame drawn, so it takes the picture and the canvas as they are rather than a new object.
 */
export function viewMap(
  out: Float32Array,
  matrix: readonly number[],
  frame: Shown,
  canvas: Canvas,
) {
  const [a = 1, b = 0, , c = 0, d = 1] = matrix;
  const det = a * d - b * c;
  // A matrix that collapses the frame is no transform at all.
  if (det === 0) return viewMap(out, IDENTITY, frame, canvas);
  const width = frame.displayWidth;
  const height = frame.displayHeight;

  const displayWidth = Math.abs(a) * width + Math.abs(c) * height;
  const displayHeight = Math.abs(b) * width + Math.abs(d) * height;
  const fit = Math.min(canvas.width / displayWidth, canvas.height / displayHeight);
  // Clip space to display pixels from the centre, y down.
  const sx = canvas.width / (2 * fit);
  const sy = -canvas.height / (2 * fit);
  // Then by the inverse matrix to frame pixels from the centre, then to texture coordinates.
  out[0] = (d / det / width) * sx;
  out[1] = (-b / det / height) * sx;
  out[2] = (-c / det / width) * sy;
  out[3] = (a / det / height) * sy;
  out[4] = 0.5;
  out[5] = 0.5;
}

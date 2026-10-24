// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The frame queue (src/frames.ts) and the compositor's fit (src/compositor.ts), in Chromium: the
// queue keeps frames in presentation order, hands out the latest one due and closes those it
// skips, and counts bytes, not frames; a frame of another shape than the canvas is centred
// with black bars, and Y′CbCr becomes the R′G′B′ FFmpeg makes of it; and a stream's frames are
// drawn straight from the GPU only where Chromium's conversion of them measures as FFmpeg's. test/render.test.ts covers both in the browsers.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { colorSpace } from "../src/codec";
import { createRoute, undoMatrix, verdict, viewMap, yuvMatrix } from "../src/compositor";
import { createFrameQueue } from "../src/frames";

function frames(...timestamps: number[]) {
  const closed: number[] = [];
  const all = timestamps.map((timestamp) => ({ timestamp, close: () => closed.push(timestamp) }));
  return { all, closed };
}

test("frames come out in presentation order, whatever order they go in", () => {
  const { all, closed } = frames(0, 66, 33, 100);
  const queue = createFrameQueue(1000, () => 1);
  for (const f of all) queue.push(f);
  expect(queue.take(-1)).toBeUndefined();
  expect(queue.take(0)?.timestamp).toBe(0);
  expect(queue.take(10)).toBeUndefined();
  expect(queue.take(33)?.timestamp).toBe(33);
  expect(closed).toEqual([]);
});

test("a jump hands out the latest frame due and closes the ones before it", () => {
  const { all, closed } = frames(0, 33, 66, 100);
  const queue = createFrameQueue(1000, () => 1);
  for (const f of all) queue.push(f);
  expect(queue.take(80)?.timestamp).toBe(66);
  expect(closed).toEqual([0, 33]);
  queue.clear();
  expect(closed).toEqual([0, 33, 100]);
});

test("the budget counts bytes, and taking frames frees them", () => {
  const { all } = frames(0, 33, 66);
  const queue = createFrameQueue(250, (f) => (f.timestamp === 66 ? 200 : 100));
  queue.push(all[0] ?? { timestamp: 0, close() {} });
  queue.push(all[1] ?? { timestamp: 0, close() {} });
  expect(queue.full()).toBe(false);
  queue.push(all[2] ?? { timestamp: 0, close() {} });
  expect(queue.full()).toBe(true);
  queue.take(33);
  expect(queue.full()).toBe(false);
});

test("a frame wider than the canvas is centred between bars above and below", () => {
  const map = new Float32Array(8);
  // 200 × 100 into a square: the frame takes the middle half of the height.
  viewMap(map, [65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30], 200, 100, 100, 100);
  const at = (x: number, y: number) => [
    (map[0] ?? 0) * x + (map[2] ?? 0) * y + (map[4] ?? 0),
    (map[1] ?? 0) * x + (map[3] ?? 0) * y + (map[5] ?? 0),
  ];
  // Clip space has y up, texture coordinates y down.
  expect(at(-1, 0.5)).toEqual([0, 0]);
  expect(at(1, -0.5)).toEqual([1, 1]);
  expect(at(0, 1)[1]).toBeLessThan(0);
});

test("dropping before a time keeps the latest frame due then, and the later ones", () => {
  const { all, closed } = frames(0, 33, 66, 100);
  const queue = createFrameQueue(1000, () => 1);
  for (const f of all) queue.push(f);
  queue.drop(80);
  expect(closed).toEqual([0, 33]);
  expect(queue.take(80)?.timestamp).toBe(66);
  queue.drop(80);
  expect(queue.take(100)?.timestamp).toBe(100);
  expect(closed).toEqual([0, 33]);
});

// R′G′B′ in 8-bit levels of plane values `yuv` at `depth` bits, by yuvMatrix.
function convert(space: VideoColorSpaceInit, depth: number, yuv: number[]) {
  const m = new Float32Array(16);
  yuvMatrix(m, space, depth);
  const [y = 0, u = 0, v = 0] = yuv;
  return [0, 1, 2].map((i) => {
    const level = (m[i] ?? 0) * y + (m[4 + i] ?? 0) * u + (m[8 + i] ?? 0) * v + (m[12 + i] ?? 0);
    return Math.round(Math.min(Math.max(level, 0), 1) * 255);
  });
}

test("Y′CbCr that states no colour converts as FFmpeg's: limited range, BT.601", () => {
  // A pixel of test/fixtures/mpeg2-aac.mov, which FFmpeg shows as 0, 255, 5.
  expect(convert({}, 8, [145, 56, 33])).toEqual([0, 255, 5]);
  expect(convert({}, 8, [235, 128, 128])).toEqual([255, 255, 255]);
  expect(convert({}, 8, [16, 128, 128])).toEqual([0, 0, 0]);
});

// Not from FFmpeg: worked out from the matrices and ranges of H.273.
test("the stated matrix, range and bit depth change the conversion", () => {
  expect(convert({ matrix: "bt709" }, 8, [145, 56, 33])).toEqual([0, 216, 0]);
  expect(convert({ fullRange: true }, 8, [255, 128, 128])).toEqual([255, 255, 255]);
  expect(convert({ matrix: "bt709" }, 10, [940, 512, 512])).toEqual([255, 255, 255]);
  expect(convert({ matrix: "bt709" }, 10, [64, 512, 512])).toEqual([0, 0, 0]);
  // Planar RGB is G, B, R.
  expect(convert({ matrix: "rgb", fullRange: true }, 8, [255, 0, 128])).toEqual([128, 255, 0]);
  // RGB that states no range is full, as FFmpeg takes it.
  expect(convert({ matrix: "rgb" }, 8, [255, 0, 128])).toEqual([128, 255, 0]);
  expect(convert({ matrix: "rgb", fullRange: false }, 8, [235, 16, 16])).toEqual([0, 255, 0]);
});

test("next hands out the earliest frame, due or not", () => {
  const { all, closed } = frames(66, 0, 33);
  const queue = createFrameQueue(1000, () => 1);
  for (const f of all) queue.push(f);
  expect(queue.first()?.timestamp).toBe(0);
  expect(queue.next()?.timestamp).toBe(0);
  expect(queue.next()?.timestamp).toBe(33);
  expect(queue.count()).toBe(1);
  expect(queue.next()?.timestamp).toBe(66);
  expect(queue.next()).toBeUndefined();
  expect(closed).toEqual([]);
});

// A grid read back as the compositor measures one (src/compositor.ts): 128 × 72 points of RGBA,
// Chromium's conversion of each, then the same points as converted from the planes, `truth`.
function grid(truth: (k: number) => [number, number, number], imported: (c: number) => number) {
  const points = 128 * 72;
  const data = new Float32Array(2 * points * 4);

  for (let k = 0; k < points; k++) {
    for (const [c, value] of truth(k).entries()) {
      data[points * 4 + k * 4 + c] = value;
      data[k * 4 + c] = imported(value);
    }
  }

  return verdict(data, new Float32Array(points * 3), {}, 8, new Float32Array(16));
}

const coloured = (k: number): [number, number, number] => [
  0.2 + (0.6 * (k % 7)) / 6,
  0.2 + (0.6 * (k % 5)) / 4,
  0.5,
];
// A colour as FFmpeg names it: the DOM's types lack BT.2020, PQ and HLG.
const stated = (primaries: string, transfer: string) =>
  colorSpace({ primaries, transfer, matrix: "", range: "" });
const srgbEncode = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

test("a stream is imported as is, or with Apple's gamma undone, only where that matches", () => {
  expect(grid(coloured, (c) => c)).toBe("imported");
  // As macOS gives a hardware decoder's BT.709 frames: a pure 1.961 gamma, read as sRGB.
  expect(grid(coloured, (c) => srgbEncode(c ** 1.961))).toBe("apple");
  expect(grid(coloured, (c) => c + 0.05)).toBe("read");
});

// R′G′B′ of 8-bit plane values `yuv` as `space` converts them, unclipped.
function rgbOf(space: VideoColorSpaceInit, yuv: number[]): [number, number, number] {
  const m = new Float32Array(16);
  yuvMatrix(m, space, 8);
  const [y = 0, u = 0, v = 0] = yuv;
  const at = (i: number) =>
    (m[i] ?? 0) * y + (m[4 + i] ?? 0) * u + (m[8 + i] ?? 0) * v + (m[12 + i] ?? 0);
  return [at(0), at(1), at(2)];
}

// Apple's gamma, read as sRGB, and Chromium's conversion clipped, on its way out.
const appleEncode = (c: number) => Math.sign(c) * srgbEncode(Math.abs(c) ** 1.961);
const clipped = (c: number) => Math.min(Math.max(c, 0), 1);

// A grid of coloured plane values, the stream's conversion of each as `streams`, and Chromium's
// as `assumed`, then gamma `encode`: the route measured from it, and its `undo`.
function assumedGrid(
  streams: VideoColorSpaceInit,
  assumed: VideoColorSpaceInit,
  encode = (c: number) => c,
) {
  const points = 128 * 72;
  const data = new Float32Array(2 * points * 4);
  const undo = new Float32Array(16);

  for (let k = 0; k < points; k++) {
    // Saturated enough that some convert outside [0, 1].
    const yuv = [70 + (k % 11) * 10, 60 + (k % 7) * 22, 60 + (k % 5) * 30];
    const truth = rgbOf(streams, yuv);
    const imported = rgbOf(assumed, yuv);

    for (let c = 0; c < 3; c++) {
      data[points * 4 + k * 4 + c] = Math.min(Math.max(truth[c] ?? 0, 0), 1);
      data[k * 4 + c] = encode(imported[c] ?? 0);
    }
  }

  const via = verdict(data, new Float32Array(points * 3), streams, 8, undo);
  return { via, undo };
}

test("a stream Chromium takes for another matrix or range is imported, its conversion undone", () => {
  // Untagged, so BT.601 as FFmpeg takes it, but converted as BT.709.
  const hd = assumedGrid({}, { matrix: "bt709", fullRange: false });
  expect(hd.via).toBe("imported");
  const expected = new Float32Array(16);
  undoMatrix(expected, {}, { matrix: "bt709", fullRange: false }, 8);
  expect([...hd.undo]).toEqual([...expected]);
  expect(assumedGrid({ matrix: "bt709" }, { matrix: "bt709", fullRange: true }).via).toBe(
    "imported",
  );
  // And with Apple's gamma on top.
  expect(assumedGrid({}, { matrix: "bt709", fullRange: false }, appleEncode).via).toBe("apple");
});

test("a stream Chromium clips is never imported through another matrix", () => {
  expect(assumedGrid({}, { matrix: "bt709", fullRange: false }, clipped).via).toBe("read");
});

test("undoing a matrix takes Chromium's R′G′B′ back to the stream's", () => {
  const undo = new Float32Array(16);
  const assumed = { matrix: "bt709", fullRange: true } as const;
  undoMatrix(undo, {}, assumed, 8);
  const yuv = [140, 90, 170];
  const [r, g, b] = rgbOf(assumed, yuv);
  const mapped = [0, 1, 2].map(
    (c) =>
      (undo[c] ?? 0) * r + (undo[4 + c] ?? 0) * g + (undo[8 + c] ?? 0) * b + (undo[12 + c] ?? 0),
  );
  for (const [c, v] of rgbOf({}, yuv).entries()) expect(mapped[c]).toBeCloseTo(v, 5);
});

test("a frame too dark or too grey to tell the conversions apart decides nothing", () => {
  expect(
    grid(
      () => [0.02, 0.03, 0.02],
      (c) => c,
    ),
  ).toBeUndefined();
  expect(
    grid(
      (k) => [0.2 + (k % 3) * 0.3, 0.2 + (k % 3) * 0.3, 0.25 + (k % 3) * 0.3],
      (c) => c,
    ),
  ).toBeUndefined();
});

test("a stream whose primaries or transfer Chromium converts is never measured", () => {
  expect(createRoute({}).via).toBe("unmeasured");
  expect(createRoute({ primaries: "bt709", transfer: "smpte170m" }).via).toBe("unmeasured");
  expect(createRoute(stated("bt2020", "smpte2084")).via).toBe("read");
  expect(createRoute(stated("bt709", "arib-std-b67")).via).toBe("read");
});

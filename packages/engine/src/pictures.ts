// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The compositor's pictures: a frame's textures on the GPU, laid out by its pixel format, and
// kept in a pool by size and format when closed, so a frame allocates none of them.

import type { DecodedFrame } from "./wasm-video";

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

/** A picture with what the compositor keeps of it, made once and reused. */
export interface Slot extends Picture {
  readonly key: string;
  readonly textures: GPUTexture[];
  readonly colour: GPUBuffer | undefined;
  /**
   * For a frame imported as an external texture, the view that Chromium's conversion of it is
   * drawn into, made once.
   */
  readonly imported: GPUTextureView | undefined;
  /** Where each plane is written, made once so that an upload allocates none. */
  readonly destinations: { texture: GPUTexture }[];
}

/** What a new slot is made of: a Y′CbCr picture has a `colour`, an imported one its view. */
interface SlotParts {
  readonly key: string;
  readonly textures: GPUTexture[];
  readonly bindGroup: GPUBindGroup;
  readonly colour?: GPUBuffer;
  readonly imported?: GPUTextureView;
}

export interface Layout {
  readonly yuv: boolean;
  readonly depth: number;
  readonly planes: [GPUTextureFormat, number, number][];
}

/**
 * How a frame of `format` is uploaded: the texture format and size of each plane used, its
 * bit depth, and whether it is Y′CbCr. An alpha plane is left out: the canvas is opaque.
 */
export function planesOf(format: VideoPixelFormat, width: number, height: number): Layout {
  const halfWidth = (width + 1) >> 1;
  const halfHeight = (height + 1) >> 1;

  if (format === "NV12") {
    return {
      yuv: true,
      depth: 8,
      planes: [
        ["r8uint", width, height],
        ["rg8uint", halfWidth, halfHeight],
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
    ? [halfWidth, halfHeight]
    : format.startsWith("I422")
      ? [halfWidth, height]
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

/**
 * A frame's visible size. A frame FFmpeg decoded holds only its visible part, so its coded size
 * is its visible size.
 */
export const visibleWidth = (frame: DecodedFrame) =>
  frame instanceof VideoFrame ? (frame.visibleRect?.width ?? frame.codedWidth) : frame.codedWidth;
export const visibleHeight = (frame: DecodedFrame) =>
  frame instanceof VideoFrame
    ? (frame.visibleRect?.height ?? frame.codedHeight)
    : frame.codedHeight;

/** The views of a Y′CbCr picture's planes Y, Cb and Cr: NV12 has Cb and Cr in one. */
export function planeViews(textures: GPUTexture[]) {
  const views = textures.map((t) => t.createView());
  const y = views[0];
  if (!y) throw new Error("a picture without planes");
  const u = views[1] ?? y;
  return [y, u, views[2] ?? u] as const;
}

/** The pictures closed, by size and format, for the next frames. */
export function createPool() {
  const free = new Map<string, Slot[]>();
  // The kind and size of the frames uploaded last, and what follows from them, worked out
  // again only when they change, so a frame allocates none of it.
  const shape = {
    kind: "",
    width: 0,
    height: 0,
    key: "",
    planes: undefined as Layout | undefined,
  };

  // The key of the pictures of frames of `kind` and size, the same string while they stay.
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

  // A picture of `key` from those closed, if any. Those of another key are destroyed: a
  // stream's frames keep one size and format, so they are of a stream before.
  function acquire(key: string) {
    for (const [other, slots] of free) {
      if (other === key) continue;

      for (const slot of slots) {
        for (const texture of slot.textures) texture.destroy();
        slot.colour?.destroy();
      }

      free.delete(other);
    }

    return free.get(key)?.pop();
  }

  // A new picture, which goes back to the pool when closed.
  function makeSlot({ key, textures, bindGroup, colour, imported }: SlotParts): Slot {
    const picture: Slot = {
      key,
      textures,
      destinations: textures.map((t) => ({ texture: t })),
      colour,
      imported,
      bindGroup,
      yuv: colour !== undefined,
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

  return { shape, keyOf, acquire, makeSlot };
}

export type Pool = ReturnType<typeof createPool>;

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The WebGPU compositor. A frame whose planes can be read is converted here, with its own matrix
// and range, so every decoder's frames look the same and keep every bit; one whose planes cannot
// (a 10-bit hardware frame) is converted by Chromium (docs/architecture.md#colour).

import { yuvMatrix } from "./colour";
import { createMeasurer, type Measurer, type Route } from "./measure";
import {
  createPool,
  planesOf,
  planeViews,
  visibleHeight,
  visibleWidth,
  type Layout,
  type Picture,
  type Pool,
  type Slot,
} from "./pictures";
import { createPipelines, IMPORTED, type Pipelines } from "./shaders";
import { viewMap } from "./view";
import type { DecodedFrame } from "./wasm-video";

// The colour uniform: mat4x4f, then u32, padded to 80 bytes.
const COLOUR_FLOATS = 20;

/** What the compositor's uploads share, made once. */
interface Gpu {
  readonly device: GPUDevice;
  readonly pipelines: Pipelines;
  readonly sampler: GPUSampler;
  // The view uniform every picture's bind group reads, written before each draw.
  readonly viewBuffer: GPUBuffer;
  // The import's `undo`, written before each frame imported.
  readonly undoBuffer: GPUBuffer;
  readonly pool: Pool;
}

const uniform = (device: GPUDevice, size: number) =>
  device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

function makePlanes(gpu: Gpu, key: string, layout: Layout): Slot {
  const { device, pipelines, sampler, viewBuffer, pool } = gpu;
  const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
  const textures = layout.planes.map(([format, w, h]) =>
    device.createTexture({ format, size: [w, h], usage }),
  );
  const [y, u, v] = planeViews(textures);

  if (!layout.yuv) {
    const bindGroup = device.createBindGroup({
      layout: pipelines.rgb.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: viewBuffer } },
        { binding: 1, resource: y },
        { binding: 2, resource: sampler },
      ],
    });
    return pool.makeSlot({ key, textures, bindGroup });
  }

  const colour = uniform(device, COLOUR_FLOATS * 4);
  const bindGroup = device.createBindGroup({
    layout: pipelines.yuv.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: viewBuffer } },
      { binding: 1, resource: y },
      { binding: 2, resource: u },
      { binding: 3, resource: v },
      { binding: 4, resource: { buffer: colour } },
    ],
  });
  return pool.makeSlot({ key, textures, bindGroup, colour });
}

// Uploads of frames whose planes are read: written into a picture's plane textures, and
// converted when drawn, by the colour the stream states.
function createPlaneUpload(gpu: Gpu, measurer: Measurer) {
  // Where a VideoFrame's planes are copied on their way to the GPU, grown as frames need.
  const staging = { buffer: new ArrayBuffer(0) };
  const colour = new Float32Array(COLOUR_FLOATS);
  const colourWords = new Uint32Array(colour.buffer);
  // What `colour` was last worked out for, so it is worked out again only when that changes.
  const converted = { space: undefined as VideoColorSpaceInit | undefined, depth: 0, pixels: "" };
  // Where a plane is read from in `staging`, filled in for each.
  const source = { offset: 0, bytesPerRow: 0 };

  // Where the planes of `frame` are: a VideoFrame's copied out into the staging buffer first.
  async function readPlanes(frame: DecodedFrame) {
    if (!(frame instanceof VideoFrame)) return { data: frame.memory.buffer, layout: frame.layout };
    const size = frame.allocationSize();
    if (size > staging.buffer.byteLength) staging.buffer = new ArrayBuffer(size);
    // readback: a frame on the read route, whose planes Chromium would convert unlike FFmpeg.
    const layout = await frame.copyTo(staging.buffer);
    return { data: staging.buffer, layout };
  }

  function writeColour(
    buffer: GPUBuffer,
    pixels: VideoPixelFormat,
    stated: VideoColorSpaceInit,
    depth: number,
  ) {
    if (stated !== converted.space || depth !== converted.depth || pixels !== converted.pixels) {
      yuvMatrix(colour, stated, depth);
      colourWords[16] = pixels === "NV12" ? 1 : 0;
      Object.assign(converted, { space: stated, depth, pixels });
    }

    gpu.device.queue.writeBuffer(buffer, 0, colour);
  }

  return async function uploadPlanes(frame: DecodedFrame, route: Route) {
    const pixels = frame.format;
    if (!pixels) throw new Error("a frame without a format has no planes to read");
    const width = visibleWidth(frame);
    const height = visibleHeight(frame);
    const { data, layout } = await readPlanes(frame);
    const { pool } = gpu;
    const key = pool.keyOf(pixels, width, height);
    pool.shape.planes ??= planesOf(pixels, width, height);
    const planes = pool.shape.planes;
    const { depth } = planes;
    const picture = pool.acquire(key) ?? makePlanes(gpu, key, planes);

    // Indexed: an iterator would allocate on every frame.
    for (let i = 0; i < picture.destinations.length; i++) {
      const plane = layout[i];
      const destination = picture.destinations[i];
      if (!plane || !destination) throw new Error(`${pixels}: no plane ${i}`);
      source.offset = plane.offset;
      source.bytesPerRow = plane.stride;
      gpu.device.queue.writeTexture(destination, data, source, destination.texture);
    }

    if (picture.colour) {
      writeColour(picture.colour, pixels, route.stated, depth);
      const unmeasured = route.via === "unmeasured" && measurer.idle();
      if (unmeasured && frame instanceof VideoFrame) measurer.start(frame, picture, route, depth);
    }

    return picture;
  };
}

function makeImported(gpu: Gpu, key: string, width: number, height: number): Slot {
  const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
  const picked = gpu.device.createTexture({ format: IMPORTED, size: [width, height], usage });
  const imported = picked.createView();
  const bindGroup = gpu.device.createBindGroup({
    layout: gpu.pipelines.rgb.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: gpu.viewBuffer } },
      { binding: 1, resource: imported },
      { binding: 2, resource: gpu.sampler },
    ],
  });
  return gpu.pool.makeSlot({ key, textures: [picked], bindGroup, imported });
}

// Converts `frame` into a picture with Chromium's conversion, undoing Apple's gamma (`apple`)
// and then mapping it by `undo`.
function uploadImported(gpu: Gpu, frame: VideoFrame, apple: boolean, undo: Float32Array) {
  const { device, pipelines, pool } = gpu;
  const width = visibleWidth(frame);
  const height = visibleHeight(frame);
  const key = pool.keyOf(IMPORTED, width, height);
  const picture = pool.acquire(key) ?? makeImported(gpu, key, width, height);
  const into = picture.imported;
  if (!into) throw new Error("no picture texture");
  // Each pipeline has a layout of its own.
  const converting = apple ? pipelines.apple : pipelines.import;
  // An external texture lasts one task, so it needs a bind group of its own.
  const bindGroup = device.createBindGroup({
    layout: converting.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: device.importExternalTexture({ source: frame }) },
      { binding: 1, resource: gpu.sampler },
      { binding: 2, resource: { buffer: gpu.undoBuffer } },
    ],
  });
  device.queue.writeBuffer(gpu.undoBuffer, 0, undo);
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

/** A compositor drawing with `device` into `context`, configured for it with `format`. */
export function createCompositor(
  device: GPUDevice,
  context: GPUCanvasContext,
  format: GPUTextureFormat,
) {
  const pipelines = createPipelines(device, format);
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  // mat2x2f, then vec2f, padded to 32 bytes.
  const view = new Float32Array(8);
  const viewBuffer = uniform(device, view.byteLength);
  const undoBuffer = uniform(device, 64);
  const gpu: Gpu = { device, pipelines, sampler, viewBuffer, undoBuffer, pool: createPool() };
  const measurer = createMeasurer({ device, pipeline: pipelines.measure, sampler });
  const uploadPlanes = createPlaneUpload(gpu, measurer);
  // The last upload, which the next waits for, as they share the staging buffer and the pool.
  const uploads = { last: Promise.resolve() };

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
          ? uploadImported(gpu, frame, route.via === "apple", route.undo)
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
    viewMap(view, matrix, picture, context.canvas);
    device.queue.writeBuffer(viewBuffer, 0, view);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [target()] });
    pass.setPipeline(picture.yuv ? pipelines.yuv : pipelines.rgb);
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
    /** Resolves once the GPU has done the work sent to it so far. */
    done: () => device.queue.onSubmittedWorkDone(),
    /** Resolves once the last measurement started has ended, for the tests. */
    measured: measurer.done,
  };
}

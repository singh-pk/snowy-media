// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The compositor's shaders (docs/architecture.md#colour), and the render pipelines made of them:
// drawing a picture into the canvas from its Y′CbCr planes or from RGB, converting a frame with
// Chromium's conversion, and measuring both conversions of a frame against each other
// (src/measure.ts).

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

// A frame converted by Chromium. Where Chromium took it for Apple's BT.709, a gamma of 1.961, and
// encoded it as sRGB (`apple`), that is undone; where it took another matrix or range than the
// stream's, `undo` maps its R′G′B′ to the stream's (docs/architecture.md#colour).
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
  // Mirrored about 0, as Chromium encodes values below 0, which \`undo\` needs: it mixes channels.
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

/** What a picture converted by Chromium is stored as: 10 bits a channel, 4 bytes a pixel. */
export const IMPORTED: GPUTextureFormat = "rgb10a2unorm";

/** What a measurement is drawn into: both conversions of each point, in 32-bit floats. */
export const MEASURED: GPUTextureFormat = "rgba32float";

/** The compositor's pipelines, drawing into a canvas configured with `format`. */
export function createPipelines(device: GPUDevice, format: GPUTextureFormat) {
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

  return {
    yuv: pipeline(YUV_SHADER, [format]),
    rgb: pipeline(RGB_SHADER, [format]),
    import: pipeline(IMPORT_SHADER, [IMPORTED]),
    apple: pipeline(IMPORT_SHADER, [IMPORTED], { apple: 1 }),
    measure: pipeline(MEASURE_SHADER, [MEASURED, MEASURED]),
  };
}

export type Pipelines = ReturnType<typeof createPipelines>;

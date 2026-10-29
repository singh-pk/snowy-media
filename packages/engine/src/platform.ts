// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The platform check on the main thread (docs/architecture.md#one-platform). `createEngine` runs it
// once, before anything starts, and the render worker checks the rest; nothing else in the engine
// checks for features.

import type { Missing, PlatformFeature } from "./protocol";

// The smallest valid modules that use a SIMD instruction, and a shared memory with an atomic
// load: WebAssembly.validate rejects them where the feature is missing.
const WASM_SIMD = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);
const WASM_THREADS = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3, 1, 1, 10, 11, 1, 9, 0, 65,
  0, 254, 16, 2, 0, 26, 11,
]);

/** What `createEngine` rejects with when the browser lacks a feature the engine needs. */
export class UnsupportedPlatformError extends Error {
  /** The first missing feature. */
  readonly feature: PlatformFeature;

  constructor([feature, reason]: Missing) {
    super(`Unsupported platform: ${feature} (${reason})`);
    this.name = "UnsupportedPlatformError";
    this.feature = feature;
  }
}

/** The first feature the main thread finds missing, or undefined. */
export function checkMainThread(): Missing | undefined {
  if (!crossOriginIsolated) {
    return [
      "cross-origin-isolation",
      "serve the page with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp",
    ];
  }

  if (!WebAssembly.validate(WASM_SIMD)) return ["wasm-simd", "WebAssembly SIMD is off"];
  if (!WebAssembly.validate(WASM_THREADS)) return ["wasm-threads", "WebAssembly threads are off"];
  if (typeof AudioWorkletNode === "undefined")
    return ["audio-worklet", "AudioWorkletNode is missing"];

  if (typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== "function") {
    return ["offscreen-canvas", "canvas.transferControlToOffscreen is missing"];
  }

  return undefined;
}

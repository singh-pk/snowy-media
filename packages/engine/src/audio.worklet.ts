// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Plays the PCM ring (src/pcm.ts) until it is closed (docs/architecture.md#audio-and-clock). It
// runs on the audio rendering thread, so it never blocks and never allocates.

/// <reference types="audioworklet" />

import { AUDIO_PROCESSOR, type AudioOptions, createPcmConsumer } from "./pcm";

registerProcessor(
  AUDIO_PROCESSOR,
  class extends AudioWorkletProcessor {
    readonly #pcm: ReturnType<typeof createPcmConsumer>;

    constructor(options: { processorOptions: AudioOptions }) {
      super();
      const { ring, layers } = options.processorOptions;
      this.#pcm = createPcmConsumer(ring, layers);
    }

    process(_: Float32Array[][], outputs: Float32Array[][]) {
      const output = outputs[0];
      if (output) this.#pcm.read(output, currentFrame);
      // Once the ring is closed, false lets the disconnected node and this processor go.
      return !this.#pcm.closed();
    }
  },
);

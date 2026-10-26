// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Audio decode benchmark worker, one fresh worker per run. Message: { files }. For each
// file: open, then demux and decode its first audio stream to float planar, copying every
// frame out of the WASM heap as a hand-off to an AudioWorklet would.

import { AVMEDIA_TYPE_AUDIO } from "/dist/core/index.js";
import { answerRuns, decodeFirst } from "/bench/decoding.js";

async function measure(env, file) {
  const result = { samples: 0, channels: 0, sampleRate: 0 };
  let scratch = new Float32Array(0);

  const onFrame = (m, fltp) => {
    const n = m._sny_frame_samples(fltp);
    result.samples += n;
    result.channels = m._sny_frame_channels(fltp);
    result.sampleRate = m._sny_frame_sample_rate(fltp);
    if (scratch.length < n) scratch = new Float32Array(n);

    for (let c = 0; c < result.channels; c++) {
      const plane = m._sny_frame_plane(fltp, c) >> 2;
      scratch.set(m.HEAPF32.subarray(plane, plane + n));
    }
  };

  const t = performance.now();
  const end = await decodeFirst(env, file, { type: AVMEDIA_TYPE_AUDIO, onFrame });
  const ms = end - t;
  const seconds = result.samples / result.sampleRate;
  return { ...result, ms, realtime: seconds / (ms / 1000) };
}

answerRuns(measure);

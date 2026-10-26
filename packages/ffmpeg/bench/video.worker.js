// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Video decode benchmark worker, one fresh worker per run. Message: { files, threads, dist }.
// For each file: open, then demux and decode its first video stream on `threads` threads,
// converting each frame to a VideoFrame format and copying it out of the WASM heap as a
// hand-off to a VideoFrame would. Timing starts once the decoder is open, so it leaves out
// loading the module and starting its threads.

import { AVMEDIA_TYPE_VIDEO } from "/dist/core/index.js";
import { answerRuns, decodeFirst } from "/bench/decoding.js";

async function measure(env, file, { threads }) {
  const result = { frames: 0, width: 0, height: 0 };
  let module = null;
  let packed = 0;
  let capacity = 0;
  let scratch = new Uint8Array(0);

  const onFrame = (m, frame) => {
    const size = m._sny_frame_pack_size(frame);

    if (size > capacity) {
      m._free(packed);
      packed = m._malloc(size);
      capacity = size;
      scratch = new Uint8Array(size);
    }

    module = m;
    m._sny_frame_pack(frame, packed, size);
    scratch.set(m.HEAPU8.subarray(packed, packed + size));
    result.frames++;
    result.width = m._sny_frame_width(frame);
    result.height = m._sny_frame_height(frame);
  };

  try {
    let t = 0;
    const end = await decodeFirst(env, file, {
      type: AVMEDIA_TYPE_VIDEO,
      threads,
      onOpen: () => (t = performance.now()),
      onFrame,
    });
    const ms = end - t;
    return { ...result, ms, fps: result.frames / (ms / 1000) };
  } finally {
    module?._free(packed);
  }
}

answerRuns(measure);

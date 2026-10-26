// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// What the decode benchmark workers share: answering a run's message with a result per file,
// and demuxing and decoding a file's first stream of one media type.

import { createCore } from "/dist/core/index.js";
import { createDecoders } from "/test/support/decoder.js";
import { attachFileSource } from "/test/support/file-source.js";
import { check, firstStream, openInput, readAll } from "/test/support/input.js";

/**
 * Answers the worker's message `{ files, dist, ... }` with `{ [name]: result }`, where result
 * is what `measure({ core, source, openDecoder }, file, message)` returns for the file, or its
 * error. Call it before any await, so the first message isn't lost.
 */
export function answerRuns(measure) {
  const ready = createCore();

  async function run(message) {
    try {
      const core = await ready;
      core._sny_set_log_level(16); // errors only
      const source = attachFileSource(core);
      const env = { core, source, openDecoder: createDecoders(core, { dist: message.dist }) };
      const results = {};

      for (const file of message.files) {
        try {
          results[file.name] = await measure(env, file, message);
        } catch (e) {
          results[file.name] = { error: String(e) };
        }
      }

      self.postMessage(results);
    } catch (e) {
      self.postMessage({ error: String(e?.stack ?? e) });
    }
  }

  self.addEventListener("message", ({ data }) => void run(data));
}

/**
 * Opens `file`, then demuxes and decodes its first stream of media type `type` on `threads`
 * threads, passing each frame to `onFrame` as decoder.js does. Calls `onOpen` once the decoder
 * is open, and returns performance.now() from when the last frame is out, before anything is
 * closed, so a caller can time either span.
 */
export async function decodeFirst(env, file, { type, threads = 1, onOpen = () => {}, onFrame }) {
  const { core, source, openDecoder } = env;
  const ctx = openInput(core, source, file);
  const pkt = core._sny_packet_alloc();
  let decoder = null;

  try {
    check(core, core._sny_find_stream_info(ctx), "find_stream_info");
    const stream = firstStream(core, ctx, type);
    decoder = await openDecoder(ctx, stream, threads);
    onOpen();

    readAll(core, ctx, pkt, () => {
      if (core._sny_packet_stream(pkt) === stream) decoder.decode(pkt, onFrame);
    });

    decoder.decode(0, onFrame);
    return performance.now();
  } finally {
    decoder?.close();
    core._sny_packet_free(pkt);
    core._sny_close(ctx);
  }
}

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Opens a file in core and reads its packets, as every test and benchmark worker does.

import { AVERROR_EOF, AVMEDIA_TYPE_AUDIO, AVMEDIA_TYPE_VIDEO } from "/dist/core/index.js";

const TYPE_NAMES = { [AVMEDIA_TYPE_AUDIO]: "audio", [AVMEDIA_TYPE_VIDEO]: "video" };

// Returns `ret`, or throws FFmpeg's message for it when it is a negative AVERROR.
export function check(m, ret, what) {
  if (ret < 0) throw new Error(`${what}: ${m.UTF8ToString(m._sny_strerror(ret))}`);
  return ret;
}

/**
 * Opens `file` in `core`, reading through `source` (file-source.js), and returns the demuxer.
 * The file's name is the format hint unless `named` is false.
 */
export function openInput(core, source, file, { named = true } = {}) {
  source.open(file);
  const out = core._malloc(4);
  const name = named ? core.stringToNewUTF8(file.name) : 0;
  const opened = core._sny_open(1, 1 << 22, name, out);
  const ctx = core.HEAP32[out >> 2];
  core._free(name);
  core._free(out);
  check(core, opened, "open");
  return ctx;
}

// The index of the first stream of media type `type` in demuxer `ctx`.
export function firstStream(core, ctx, type) {
  const count = core._sny_nb_streams(ctx);

  for (let i = 0; i < count; i++) {
    if (core._sny_codec_type(core._sny_stream(ctx, i)) === type) return i;
  }

  throw new Error(`no ${TYPE_NAMES[type]} stream`);
}

// Reads every packet of demuxer `ctx` into `pkt`, calling take(pkt) after each.
export function readAll(core, ctx, pkt, take) {
  for (;;) {
    const ret = core._sny_read(ctx, pkt);
    if (ret === AVERROR_EOF) return;
    check(core, ret, "read");
    take(pkt);
  }
}

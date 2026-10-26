// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Decodes audio streams to 32-bit float planar frames and video streams to a format a
// WebCodecs VideoFrame accepts. Shared by the tests and the benchmarks, and the loop every
// caller needs: send each packet, take every frame it produces, and drain with a null packet
// at the end. A stream core doesn't decode is decoded by the module sny_codec_module names,
// loaded on first use, with the same loop.

import { AVERROR_EAGAIN, AVERROR_EOF, AVMEDIA_TYPE_AUDIO } from "/dist/core/index.js";
import { check } from "/test/support/input.js";

// How each media type is converted, with the state the conversion keeps between frames.
const AUDIO = {
  alloc: (m) => m._sny_converter_alloc(),
  convert: (m, state, frame, out) => m._sny_to_float_planar(state, frame, out),
  free: (m, state) => m._sny_converter_free(state),
};
const VIDEO = {
  alloc: (m) => m._sny_scaler_alloc(),
  convert: (m, state, frame, out) => m._sny_to_video_format(state, frame, out),
  free: (m, state) => m._sny_scaler_free(state),
};

// Module `name` from the build in `dist`, through its Emscripten factory.
async function loadModule(dist, name) {
  const { default: create } = await import(`${dist}/${name}/${name}.js`);
  const m = await create();
  m._sny_set_log_level(16); // errors only
  return m;
}

// Calls open(out) and returns the decoder it stores, or the negative AVERROR it returns.
function openWith(m, open) {
  const out = m._malloc(4);
  const ret = open(out);
  const dec = m.HEAP32[out >> 2];
  m._free(out);
  return ret < 0 ? ret : dec;
}

/**
 * Returns `open(ctx, stream, threads)`, which opens a decoder for audio or video stream
 * `stream` of the demuxer `ctx` in `core`, video on up to `threads` threads.
 * `decode(pkt, onFrame)` calls `onFrame(m, out, frame)` for every frame the packet completes
 * (pkt 0 drains), where `m` is the module holding the frames, `frame` is the decoder's and
 * `out` is it converted (float planar, or a VideoFrame format); read them with
 * `m._sny_frame_*` before returning. A packet the decoder rejects on send is skipped, as the
 * ffmpeg command line does; an error receiving a frame throws. With `transferAll`, streams
 * core decodes also go through the copy that feeds the other modules, into core itself (for
 * tests). The other modules load from `dist`.
 */
export function createDecoders(core, { transferAll = false, dist = "/dist" } = {}) {
  const modules = new Map(); // name -> the module loading, once a stream needs it

  async function open(ctx, stream, threads = 1) {
    const st = core._sny_stream(ctx, stream);
    const kind = core._sny_codec_type(st) === AVMEDIA_TYPE_AUDIO ? AUDIO : VIDEO;
    const at = core._sny_codec_module(ctx, stream);
    if (!at) throw new Error(`stream ${stream}: no module decodes it`);
    const name = core.UTF8ToString(at);

    if (name === "core") {
      if (transferAll) return transfer(core, core, kind, { ctx, stream, threads: 1 });
      const dec = openWith(core, (out) => core._sny_decoder_open(ctx, stream, out));
      return loop(core, kind, check(core, dec, "decoder_open"));
    }

    if (!modules.has(name)) modules.set(name, loadModule(dist, name));
    const m = await modules.get(name);
    return transfer(core, m, kind, { ctx, stream, threads });
  }

  return open;
}

// Opens a decoder for `stream` in module `m` on `threads` threads, copying the stream's
// codec parameters and then each packet from core.
function transfer(core, m, kind, { ctx, stream, threads }) {
  const out = core._malloc(4);
  const size = core._sny_params_export(ctx, stream, out);
  const params = core.HEAP32[out >> 2];
  core._free(out);
  check(core, size, "params_export");
  const buf = m._malloc(size);

  if (!buf) {
    core._free(params);
    throw new Error("malloc: out of memory");
  }

  m.HEAPU8.set(core.HEAPU8.subarray(params, params + size), buf);
  core._free(params);
  const dec = openWith(m, (o) => m._sny_decoder_open_params(buf, size, threads, o));
  m._free(buf);
  check(m, dec, "decoder_open_params");
  const pkt = m._sny_packet_alloc();

  if (!pkt) {
    m._sny_decoder_close(dec);
    throw new Error("packet_alloc: out of memory");
  }

  function copy(src) {
    if (!src) return 0;
    const n = core._sny_packet_size(src);
    const data = m._sny_packet_make(
      pkt,
      n,
      core._sny_packet_pts(src),
      core._sny_packet_dts(src),
      core._sny_packet_duration(src),
      core._sny_packet_flags(src),
    );
    if (!data) throw new Error("packet_make: out of memory");
    const start = core._sny_packet_data(src);
    // m's decoder threads may have grown its memory past m.HEAPU8 (index.d.ts, wasmMemory).
    new Uint8Array(m.wasmMemory.buffer).set(core.HEAPU8.subarray(start, start + n), data);

    for (let i = 0; i < core._sny_packet_side_data_count(src); i++) {
      const bytes = core._sny_packet_side_data_size(src, i);
      const type = core._sny_packet_side_data_type(src, i);
      const to = m._sny_packet_side_data_add(pkt, type, bytes);
      if (!to) throw new Error("packet_side_data_add: out of memory");
      const from = core._sny_packet_side_data(src, i);
      new Uint8Array(m.wasmMemory.buffer).set(core.HEAPU8.subarray(from, from + bytes), to);
    }

    return pkt;
  }

  return loop(m, kind, dec, { toPacket: copy, release: () => m._sny_packet_free(pkt) });
}

// The send/receive loop over decoder `dec` of module `m`, converting frames as `kind` says.
// `toPacket` turns core's packet into one of `m`'s.
function loop(m, kind, dec, { toPacket = (pkt) => pkt, release = () => {} } = {}) {
  const state = kind.alloc(m);
  const frame = m._sny_frame_alloc();
  const out = m._sny_frame_alloc();

  function receive(onFrame) {
    for (;;) {
      const ret = m._sny_decoder_receive(dec, frame);
      if (ret === AVERROR_EAGAIN || ret === AVERROR_EOF) return;
      check(m, ret, "decoder_receive");
      check(m, kind.convert(m, state, frame, out), "convert");
      onFrame(m, out, frame);
    }
  }

  function decode(pkt, onFrame) {
    const p = toPacket(pkt);

    for (;;) {
      const ret = m._sny_decoder_send(dec, p);
      receive(onFrame);
      if (ret !== AVERROR_EAGAIN) return;
    }
  }

  function close() {
    m._sny_frame_free(out);
    m._sny_frame_free(frame);
    kind.free(m, state);
    m._sny_decoder_close(dec);
    release();
  }

  return { decode, close };
}

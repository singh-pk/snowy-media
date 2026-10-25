// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Test worker: demuxes each fixture with the WASM core through FileReaderSync I/O, decodes
// every audio and video stream, and reports what native FFmpeg reports (see
// scripts/gen-fixtures.ts). With ?transfer, streams core decodes also go through the copy
// that feeds the other modules.

import * as constants from "/dist/core/index.js";
import {
  AV_NOPTS_VALUE,
  AVERROR_EINVAL,
  AVERROR_EOF,
  AVSEEK_FLAG_BACKWARD,
  AVSEEK_FLAG_BYTE,
  createCore,
} from "/dist/core/index.js";
import { createDecoders } from "/test/support/decoder.js";
import { attachFileSource } from "/test/support/file-source.js";

const TYPES = ["video", "audio", "data", "subtitle", "attachment"];
// Must match PROBE_STRIDE in scripts/gen-fixtures.ts.
const PROBE_STRIDE = 127;
// Must match RESAMPLE_* in scripts/gen-fixtures.ts.
const RESAMPLE_RATE = 44_100;
const RESAMPLE_CHANNELS = 2;
// The video modules' thread pool (VIDEO_LDFLAGS in the Dockerfile). Video decodes on up to 4
// threads, so frame threading runs in the tests.
const POOL = Math.min(navigator.hardwareConcurrency, 8);
const THREADS = Math.min(POOL, 4);

// Every AV_DISPOSITION_* constant, by ffprobe's name for it.
const DISPOSITIONS = Object.entries(constants)
  .filter(([k]) => k.startsWith("AV_DISPOSITION_"))
  .map(([k, flag]) => [k.slice("AV_DISPOSITION_".length).toLowerCase(), flag]);

const timestamp = (v) => (v === AV_NOPTS_VALUE ? null : String(v));

// Appends a frame decoded in module m to d.audio, channels interleaved as native FFmpeg
// writes them.
function append(d, m, fltp) {
  const n = m._sny_frame_samples(fltp);
  const channels = m._sny_frame_channels(fltp);
  const pcm = new Float32Array(n * channels);

  for (let c = 0; c < channels; c++) {
    const plane = m._sny_frame_plane(fltp, c) >> 2;
    for (let i = 0; i < n; i++) pcm[i * channels + c] = m.HEAPF32[plane + i];
  }

  d.chunks.push(pcm);
  d.audio.frames++;
  d.audio.samples += n;
  if (d.audio.firstPts.length < 3) d.audio.firstPts.push(timestamp(m._sny_frame_pts(fltp)));
}

// Resamples a frame decoded in module m, or 0 at the end of the stream, onto d.resampled,
// as an AudioWorklet would play it.
function resample(d, m, frame) {
  d.swr ??= { m, ctx: m._sny_resampler_alloc(), out: m._sny_frame_alloc() };
  const { ctx, out } = d.swr;
  const ret = m._sny_resample(ctx, frame, out, RESAMPLE_RATE, RESAMPLE_CHANNELS);
  if (ret < 0) throw new Error(`resample: ${m.UTF8ToString(m._sny_strerror(ret))}`);
  const at = m._sny_frame_plane(out, 0) >> 2;
  const n = m._sny_frame_samples(out) * RESAMPLE_CHANNELS;
  d.resampled.push(m.HEAPF32.slice(at, at + n));
}

// The frame's planes packed as native FFmpeg's rawvideo encoder writes them, copied out of
// the WASM heap.
function pack(m, frame) {
  const size = m._sny_frame_pack_size(frame);
  if (size < 0) throw new Error(`frame_pack_size: ${size}`);
  const dst = m._malloc(size);
  const written = m._sny_frame_pack(frame, dst, size);
  const bytes = m.HEAPU8.slice(dst, dst + size);
  m._free(dst);
  if (written < 0) throw new Error(`frame_pack: ${written}`);
  return bytes;
}

// "ok" when `out`, a frame converted by sny_to_video_format and packed as `bytes`,
// constructs a VideoFrame.
function toVideoFrame(m, out, bytes) {
  const at = m._sny_frame_video_format(out);
  if (!at) return `no VideoFrame format for ${m.UTF8ToString(m._sny_frame_pix_fmt(out))}`;
  const format = m.UTF8ToString(at);
  const init = {
    format,
    codedWidth: m._sny_frame_width(out),
    codedHeight: m._sny_frame_height(out),
    timestamp: 0,
  };

  try {
    const frame = new VideoFrame(bytes, init);
    // A wrong format name or plane layout shows as a size other than the packed one.
    const size = frame.allocationSize();
    frame.close();
    return size === bytes.length
      ? "ok"
      : `${format}: allocationSize ${size}, packed ${bytes.length}`;
  } catch (e) {
    return `${format}: ${String(e)}`;
  }
}

// Appends a frame decoded in module m to d.video, packed as native FFmpeg writes it, and
// its converted form, when sny_to_video_format converted it, to d.converted; and checks that
// the converted form makes a VideoFrame.
function appendVideo(d, m, out, frame) {
  const v = d.video;
  v.frames++;
  if (v.firstPts.length < 3) v.firstPts.push(timestamp(m._sny_frame_pts(frame)));
  v.width ??= m._sny_frame_width(frame);
  v.height ??= m._sny_frame_height(frame);
  v.pixFmt ??= m.UTF8ToString(m._sny_frame_pix_fmt(frame));
  const fmt = m._sny_frame_format(frame);
  v.depth ??= m._sny_pix_fmt_depth(fmt);
  v.chroma ??= [m._sny_pix_fmt_log2_chroma_w(fmt), m._sny_pix_fmt_log2_chroma_h(fmt)];
  // ffprobe prints a value without a name as "unknown".
  const name = (ptr, none = "unknown") => (ptr ? m.UTF8ToString(ptr) : none);
  v.color ??= {
    range: name(m._sny_color_range_name(m._sny_frame_color_range(frame))),
    primaries: name(m._sny_color_primaries_name(m._sny_frame_color_primaries(frame))),
    transfer: name(m._sny_color_trc_name(m._sny_frame_color_trc(frame))),
    space: name(m._sny_color_space_name(m._sny_frame_color_space(frame))),
    chromaLocation: name(
      m._sny_chroma_location_name(m._sny_frame_chroma_location(frame)),
      "unspecified",
    ),
  };
  v.rotation ??= m._sny_frame_rotation(frame);
  const raw = pack(m, frame);
  d.chunks.push(raw);
  const pixFmt = m.UTF8ToString(m._sny_frame_pix_fmt(out));
  let bytes = raw;

  if (pixFmt !== v.pixFmt) {
    bytes = pack(m, out);
    v.convertedTo ??= pixFmt;
    d.converted.push(bytes);
  }

  if (v.videoFrame === "ok") v.videoFrame = toVideoFrame(m, out, bytes);
}

async function createDemuxer() {
  const core = await createCore();
  core._sny_set_log_level(16); // errors only
  const source = attachFileSource(core);
  const transferAll = new URL(import.meta.url).searchParams.has("transfer");
  const openDecoder = createDecoders(core, { transferAll });

  const str = (ptr) => (ptr ? core.UTF8ToString(ptr) : null);

  const pts = (pkt) => timestamp(core._sny_packet_pts(pkt));

  function check(ret, what) {
    if (ret < 0) throw new Error(`${what}: ${str(core._sny_strerror(ret))}`);
    return ret;
  }

  async function demux(file) {
    source.open(file);
    const out = core._malloc(4);
    const name = core.stringToNewUTF8(file.name);
    const opened = core._sny_open(1, 1 << 22, name, out);
    const ctx = core.HEAP32[out >> 2];
    core._free(name);
    core._free(out);
    check(opened, "open");
    const pkt = core._sny_packet_alloc();
    const moved = core._sny_packet_alloc();
    const decoders = new Map();

    try {
      check(core._sny_find_stream_info(ctx), "find_stream_info");
      const streams = [];

      for (let i = 0; i < core._sny_nb_streams(ctx); i++) {
        const st = core._sny_stream(ctx, i);
        const stream = {
          type: TYPES[core._sny_codec_type(st)],
          codec: str(core._sny_codec_name(st)),
          packets: 0,
          firstPts: [],
          disposition: DISPOSITIONS.filter(([, flag]) => core._sny_stream_disposition(st) & flag)
            .map(([key]) => key)
            .toSorted((a, b) => a.localeCompare(b)),
        };
        streams.push(stream);

        if (stream.type === "audio") {
          stream.audio = { frames: 0, samples: 0, firstPts: [] };
          const decoder = await openDecoder(ctx, i);
          const d = { audio: stream.audio, chunks: [], resampled: [], decoder };

          d.onFrame = (m, fltp, frame) => {
            append(d, m, fltp);
            resample(d, m, frame);
          };

          decoders.set(i, d);
        } else if (stream.type === "video") {
          stream.params = {
            matrix: Array.from({ length: 9 }, (_, k) => core._sny_stream_display_matrix(st, k)),
            rotation: core._sny_stream_rotation(st),
          };
          stream.video = { frames: 0, firstPts: [], videoFrame: "ok" };
          const decoder = await openDecoder(ctx, i, THREADS);
          const d = { video: stream.video, chunks: [], converted: [], decoder };
          d.onFrame = (m, converted, frame) => appendVideo(d, m, converted, frame);
          decoders.set(i, d);
        }
      }

      for (;;) {
        const ret = core._sny_read(ctx, pkt);
        if (ret === AVERROR_EOF) break;
        check(ret, "read");
        const index = core._sny_packet_stream(pkt);
        const s = streams[index];
        s.packets++;
        if (s.firstPts.length < 3) s.firstPts.push(pts(pkt));
        const d = decoders.get(index);
        // Decoded after a move, as the engine queues packets, so the expected frames and
        // samples check that it keeps the data, timestamps and side data.
        core._sny_packet_move(moved, pkt);
        if (core._sny_packet_size(pkt) !== 0) throw new Error("packet_move left the source");
        d?.decoder.decode(moved, d.onFrame);
      }

      for (const d of decoders.values()) {
        d.decoder.decode(0, d.onFrame); // drain

        if (d.audio) {
          if (d.swr) resample(d, d.swr.m, 0);
          d.audio.pcm = concat(d.chunks, Float32Array);
          d.audio.resampled = concat(d.resampled, Float32Array);
        } else {
          d.video.raw = concat(d.chunks, Uint8Array);
          if (d.converted.length > 0) d.video.converted = concat(d.converted, Uint8Array);
        }
      }

      // Seek back to the start and confirm the next packet is that stream's first packet again.
      // Formats with no timestamps or index (raw elementary streams) seek by byte instead.
      let rewind = "unseekable";
      const seeked =
        core._sny_seek(ctx, -1, 0n, AVSEEK_FLAG_BACKWARD) >= 0 ||
        core._sny_seek(ctx, -1, 0n, AVSEEK_FLAG_BYTE) >= 0;

      if (seeked && core._sny_read(ctx, pkt) >= 0) {
        rewind =
          pts(pkt) === streams[core._sny_packet_stream(pkt)].firstPts[0]
            ? "ok"
            : `landed at ${pts(pkt)}`;
      }

      return { format: str(core._sny_format_name(ctx)), streams, rewind };
    } finally {
      for (const d of decoders.values()) {
        d.decoder.close();

        if (d.swr) {
          d.swr.m._sny_frame_free(d.swr.out);
          d.swr.m._sny_resampler_free(d.swr.ctx);
        }
      }

      core._sny_packet_free(moved);
      core._sny_packet_free(pkt);
      core._sny_close(ctx);
    }
  }

  // Apart from resampleTwice, whose passes would otherwise nest too deep to follow.
  function readAll(ctx, pkt, take) {
    for (;;) {
      const ret = core._sny_read(ctx, pkt);
      if (ret === AVERROR_EOF) return;
      check(ret, "read");
      take(pkt);
    }
  }

  // Resamples audio stream 0 of `file` to the end, flushes the resampler as a seek does, and
  // resamples it again from the start: "same" when both passes match, as they must.
  async function resampleTwice(file) {
    source.open(file);
    const out = core._malloc(4);
    const opened = core._sny_open(1, 1 << 22, 0, out);
    const ctx = core.HEAP32[out >> 2];
    core._free(out);
    check(opened, "open");
    const pkt = core._sny_packet_alloc();
    const d = { resampled: [] };
    const passes = [];

    try {
      for (let pass = 0; pass < 2; pass++) {
        if (pass) {
          check(core._sny_seek(ctx, -1, 0n, AVSEEK_FLAG_BACKWARD), "seek");
          core._sny_resampler_flush(d.swr.ctx);
        }

        const decoder = await openDecoder(ctx, 0);

        try {
          readAll(ctx, pkt, (packet) =>
            decoder.decode(packet, (m, fltp, frame) => resample(d, m, frame)),
          );
          decoder.decode(0, (m, fltp, frame) => resample(d, m, frame));
          resample(d, core, 0);
        } finally {
          decoder.close();
        }

        passes.push(concat(d.resampled.splice(0), Float32Array));
      }

      const [a, b] = passes;
      return a.length === b.length && a.every((v, i) => v === b[i])
        ? "same"
        : `${a.length} then ${b.length} samples`;
    } finally {
      if (d.swr) {
        core._sny_frame_free(d.swr.out);
        core._sny_resampler_free(d.swr.ctx);
      }

      core._sny_packet_free(pkt);
      core._sny_close(ctx);
    }
  }

  // Opens video stream 0 of `file` on one thread more than the pool has: "rejected" when it
  // fails cleanly, as it must, instead of hanging.
  async function openBeyondPool(file) {
    source.open(file);
    const out = core._malloc(4);
    const opened = core._sny_open(1, 1 << 22, 0, out);
    const ctx = core.HEAP32[out >> 2];
    core._free(out);
    check(opened, "open");

    try {
      const decoder = await openDecoder(ctx, 0, POOL + 1);
      decoder.close();
      return "opened";
    } catch (e) {
      return String(e).includes("decoder_open_params") ? "rejected" : String(e);
    } finally {
      core._sny_close(ctx);
    }
  }

  // Opens stream 0 of subtitle file `file` in core and sends and receives on it: "rejected"
  // when both return AVERROR(EINVAL), as they must instead of corrupting memory.
  function decodeSubtitles(file) {
    source.open(file);
    const out = core._malloc(4);
    const name = core.stringToNewUTF8(file.name);
    const opened = core._sny_open(1, 1 << 22, name, out);
    const ctx = core.HEAP32[out >> 2];
    core._free(name);
    if (opened < 0) core._free(out);
    check(opened, "open");
    const decoded = core._sny_decoder_open(ctx, 0, out);
    const dec = core.HEAP32[out >> 2];
    core._free(out);
    const pkt = core._sny_packet_alloc();
    const frame = core._sny_frame_alloc();

    try {
      check(decoded, "decoder_open");
      check(core._sny_read(ctx, pkt), "read");
      const sent = core._sny_decoder_send(dec, pkt);
      const received = core._sny_decoder_receive(dec, frame);
      return sent === AVERROR_EINVAL && received === AVERROR_EINVAL
        ? "rejected"
        : `send ${sent}, receive ${received}`;
    } finally {
      if (decoded >= 0) core._sny_decoder_close(dec);
      core._sny_frame_free(frame);
      core._sny_packet_free(pkt);
      core._sny_close(ctx);
    }
  }

  return { demux, openBeyondPool, decodeSubtitles, resampleTwice, transferAll };
}

function concat(chunks, Type) {
  const out = new Type(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;

  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }

  return out;
}

async function sha256(data) {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const probeOf = (pcm) => Array.from(pcm.filter((_, i) => i % PROBE_STRIDE === 0));

// Replaces the decoded output with what the expectations hold: its SHA-256, and for audio
// every PROBE_STRIDE-th value for comparing float decoders within a tolerance.
async function summarize(result) {
  for (const s of result.streams ?? []) {
    if (s.audio) {
      const { pcm, resampled, ...audio } = s.audio;
      const digest = await sha256(pcm);
      s.audio = {
        ...audio,
        sha256: digest,
        probe: probeOf(pcm),
        resampled: { samples: resampled.length / RESAMPLE_CHANNELS, probe: probeOf(resampled) },
      };
    } else if (s.video) {
      const { raw, converted, convertedTo, ...video } = s.video;
      const digest = await sha256(raw);
      s.video = { ...video, sha256: digest };

      if (converted) {
        const convertedDigest = await sha256(converted);
        s.video.converted = { pixFmt: convertedTo, sha256: convertedDigest };
      }
    }
  }

  return result;
}

// Started before any await so the first message isn't lost.
const ready = createDemuxer();

async function run(names) {
  const { demux, openBeyondPool, decodeSubtitles, resampleTwice, transferAll } = await ready;
  const results = {};

  for (const name of names) {
    try {
      const res = await fetch(`/test/fixtures/${name}`);
      const blob = await res.blob();
      const file = new File([blob], name);
      const result = await demux(file);
      results[name] = await summarize(result);
    } catch (e) {
      results[name] = { error: String(e) };
    }
  }

  if (!transferAll) {
    const res = await fetch("/test/fixtures/h264.h264");
    const blob = await res.blob();
    results.threadPool = await openBeyondPool(new File([blob], "h264.h264"));
    const subs = await fetch("/test/fixtures/subs.srt");
    const text = await subs.blob();
    results.subtitleDecoder = decodeSubtitles(new File([text], "subs.srt"));
    const pcm = await fetch("/test/fixtures/pcm.wav");
    const wav = await pcm.blob();
    results.resampleTwice = await resampleTwice(new File([wav], "pcm.wav"));
  }

  self.postMessage(results);
}

self.addEventListener("message", ({ data }) => void run(data));

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The one thread that may block (docs/architecture.md#threads): it reads the file synchronously
// (src/io.ts) and waits for room in the packet ring (src/ring.ts) and the PCM ring (src/pcm.ts).

import {
  AV_NOPTS_VALUE,
  AVINDEX_KEYFRAME,
  AV_TIME_BASE,
  AVSEEK_FLAG_BACKWARD,
  AVERROR_EOF,
  AVMEDIA_TYPE_ATTACHMENT,
  AVMEDIA_TYPE_AUDIO,
  AVMEDIA_TYPE_SUBTITLE,
  AVMEDIA_TYPE_VIDEO,
  type CoreModule,
  createCore,
  type Ptr,
} from "@snowy-media/ffmpeg/core";
import { type Audio, createAudio } from "./audio-decoder";
import { colorSpace, type VideoParams, WEBCODECS } from "./codec";
import { createFileSource } from "./io";
import { createPcmProducer } from "./pcm";
import { createProducer } from "./ring";
import { type Clip, endOf } from "./composition";
import type { FromMedia, Opened, ToMedia, Track } from "./protocol";

// The track kinds of streams that are neither video nor audio; any other type, data or unknown
// (-1), is "data".
const OTHER = new Map([
  [AVMEDIA_TYPE_SUBTITLE, "subtitle"],
  [AVMEDIA_TYPE_ATTACHMENT, "attachment"],
] as const);
// Bytes per read, 4 MiB, so the file is read in few, large slices.
const BUFFER = 1 << 22;
// The worker reads one file at a time (src/io.ts), so its one input has a fixed id.
const IO = 1;

// Loading the module starts with the worker, before the first file arrives.
const ready = startMedia();

type Media = ReturnType<typeof createState>;
type Ring = ReturnType<typeof createProducer>;
type DemuxRequest = Pick<
  Extract<ToMedia, { type: "demux" }>,
  "ring" | "streams" | "from" | "pcm" | "audio"
>;
type TrackRequest = Omit<Extract<ToMedia, { type: "track" }>, "type" | "id">;

// What a pump calls for each video packet: `ahead` before the packet in `pkt`, of `stream`, is
// offered, and `placed` once it is in the ring.
interface Reach {
  ahead: (stream: number) => void;
  placed: () => void;
}

function post(message: FromMedia) {
  self.postMessage(message);
}

function createState(core: CoreModule) {
  const str = (ptr: Ptr) => (ptr ? core.UTF8ToString(ptr) : "");

  function check(ret: number, what: string) {
    if (ret < 0) throw new Error(`${what}: ${str(core._sny_strerror(ret))}`);
  }

  return {
    core,
    str,
    check,
    source: createFileSource(core),
    // The open file's demuxer, or 0, and whether it has read past its start since it opened.
    ctx: 0,
    read: false,
    pkt: core._sny_packet_alloc(),
  };
}

function track({ core, ctx, str }: Media, id: number): Track {
  const st = core._sny_stream(ctx, id);
  const type = core._sny_codec_type(st);
  const codec = str(core._sny_codec_name(st));

  if (type === AVMEDIA_TYPE_VIDEO) {
    const [width, height] = [core._sny_codec_width(st), core._sny_codec_height(st)];
    return { id, kind: "video", codec, width, height };
  }

  if (type === AVMEDIA_TYPE_AUDIO) {
    const [sampleRate, channels] = [core._sny_codec_sample_rate(st), core._sny_codec_channels(st)];
    return { id, kind: "audio", codec, sampleRate, channels };
  }

  return { id, kind: OTHER.get(type) ?? "data", codec };
}

// Stream `id`'s codec parameters, exported for the FFmpeg module that decodes it.
function exportParams({ core, ctx, check }: Media, id: number) {
  const out = core._malloc(4);
  const size = core._sny_params_export(ctx, id, out);
  const at = core.HEAP32[out >>> 2] ?? 0;
  core._free(out);
  check(size, "params_export");
  // copy: out of FFmpeg's memory, which is freed below.
  const params = core.HEAPU8.slice(at, at + size);
  core._free(at);
  return params;
}

// What decodes video stream `id`: WebCodecs, the FFmpeg module that holds its decoder, or "none".
function videoDecoder({ core, ctx, str }: Media, id: number, codec: string) {
  if (WEBCODECS.has(codec)) return "webcodecs";
  const module = str(core._sny_codec_module(ctx, id));
  return module === "video" || module === "video-ext" ? module : "none";
}

// What decodes a video stream: a WebCodecs decoder config is made from these (src/codec.ts),
// or an FFmpeg module opens its decoder with `params`.
function videoParams(m: Media, id: number): VideoParams {
  const { core, str } = m;
  const st = core._sny_stream(m.ctx, id);
  const data = core._sny_codec_extradata(st);
  const tag = core._sny_codec_tag(st);
  const start = core._sny_stream_start_time(st);
  const codec = str(core._sny_codec_name(st));
  const decoder = videoDecoder(m, id, codec);
  return {
    codec,
    decoder,
    params: decoder === "video" || decoder === "video-ext" ? exportParams(m, id) : new Uint8Array(),
    // A little-endian four-character code, or 0.
    tag: tag
      ? String.fromCodePoint(tag & 255, (tag >>> 8) & 255, (tag >>> 16) & 255, tag >>> 24)
      : "",
    // copy: out of FFmpeg's memory, once per stream, for the decoder on another thread.
    extradata: core.HEAPU8.slice(data, data + core._sny_codec_extradata_size(st)),
    width: core._sny_codec_width(st),
    height: core._sny_codec_height(st),
    level: core._sny_codec_level(st),
    sampleAspect: [core._sny_codec_sar_num(st), core._sny_codec_sar_den(st)],
    colorSpace: colorSpace({
      primaries: str(core._sny_color_primaries_name(core._sny_codec_color_primaries(st))),
      transfer: str(core._sny_color_trc_name(core._sny_codec_color_trc(st))),
      matrix: str(core._sny_color_space_name(core._sny_codec_color_space(st))),
      range: str(core._sny_color_range_name(core._sny_codec_color_range(st))),
    }),
    timeBase: [core._sny_stream_tb_num(st), core._sny_stream_tb_den(st)],
    start: start === AV_NOPTS_VALUE ? 0 : Number(start),
    matrix: Array.from({ length: 9 }, (_, i) => core._sny_stream_display_matrix(st, i)),
  };
}

function close(m: Media) {
  if (m.ctx) m.core._sny_close(m.ctx);
  m.ctx = 0;
}

function open(m: Media, file: File): Opened {
  const { core, check, str } = m;
  close(m);
  m.source.open(file);
  const out = core._malloc(4);
  const name = core.stringToNewUTF8(file.name);
  const opened = core._sny_open(IO, BUFFER, name, out);
  const ctx = core.HEAP32[out >>> 2] ?? 0;
  core._free(name);
  core._free(out);
  check(opened, "open");
  m.ctx = ctx;
  m.read = false;
  check(core._sny_find_stream_info(ctx), "find_stream_info");
  const tracks = Array.from({ length: core._sny_nb_streams(ctx) }, (_, i) => track(m, i));
  const duration = core._sny_duration(ctx);
  const video: Record<number, VideoParams> = {};
  const index: Opened["index"] = {};

  for (const t of tracks) {
    if (t.kind !== "video") continue;
    video[t.id] = videoParams(m, t.id);
    index[t.id] = keyframes(m, t.id);
  }

  // AV_NOPTS_VALUE, the only negative duration, is an unknown one.
  const info = {
    format: str(core._sny_format_name(ctx)),
    duration: duration < 0n ? undefined : Number(duration) / AV_TIME_BASE,
    tracks,
  };
  return { info, video, index };
}

// The times, in microseconds, of stream `id`'s keyframes in its demuxer's index, and of the
// index's last entry, up to which it is known (a fragmented MP4's holds only the fragments read
// so far). A time is when the frame is due, or, for some demuxers such as MP4's, decoded.
function keyframes({ core, ctx }: Media, id: number) {
  const st = core._sny_stream(ctx, id);
  const [num, den] = [core._sny_stream_tb_num(st), core._sny_stream_tb_den(st)];
  const micros = (entry: number) =>
    Math.round((Number(core._sny_index_ts(entry)) * num * 1e6) / den);
  const times: number[] = [];
  let end = -Infinity;

  for (let i = 0; i < core._sny_index_count(st); i++) {
    const entry = core._sny_index_entry(st, i);
    end = Math.max(end, micros(entry));
    if (core._sny_index_flags(entry) & AVINDEX_KEYFRAME) times.push(micros(entry));
  }

  return { keyframes: times, end };
}

// The open file's demuxer, after checking that `streams` are all streams of it.
function demuxer({ core, ctx }: Media, streams: number[]) {
  if (!ctx) throw new Error("demux: no file is open");
  const count = core._sny_nb_streams(ctx);

  for (const s of streams) {
    if (!Number.isInteger(s) || s < 0 || s >= count) throw new RangeError(`demux: no stream ${s}`);
  }

  return ctx;
}

// The open file's demuxer, after checking that `stream` is audio that the core module decodes;
// a codec in `audio-ext` throws.
function audioDemuxer(m: Media, stream: number) {
  const { core, str } = m;
  const ctx = demuxer(m, [stream]);

  if (core._sny_codec_type(core._sny_stream(ctx, stream)) !== AVMEDIA_TYPE_AUDIO) {
    throw new RangeError(`demux: stream ${stream} is not audio`);
  }

  const module = str(core._sny_codec_module(ctx, stream));
  if (!module) throw new Error(`demux: no module decodes stream ${stream}`);

  if (module !== "core") {
    throw new Error(`demux: stream ${stream} needs the ${module} module, not loaded yet`);
  }

  return ctx;
}

// Writes `pkt`, a packet of stream `stream`, into `ring`; false if it has no room.
function offer({ core, pkt }: Media, ring: Ring, stream: number) {
  const { packet } = ring;
  packet.stream = stream;
  packet.flags = core._sny_packet_flags(pkt);
  packet.pts = core._sny_packet_pts(pkt);
  packet.dts = core._sny_packet_dts(pkt);
  packet.duration = Number(core._sny_packet_duration(pkt));
  // HEAPU8 is read for each packet: the heap's buffer changes when memory grows.
  packet.data = core.HEAPU8;
  packet.offset = core._sny_packet_data(pkt);
  packet.size = core._sny_packet_size(pkt);
  return ring.offer(packet);
}

// What a pump does besides placing packets: decode `audio`, tell `reach` of each packet offered
// to the packet ring, stop where `until` says, and end with the record `ending` offers, which
// returns false while the ring has no room for it: the END record unless it says otherwise.
interface Pumped {
  audio?: Audio | undefined;
  reach?: Reach | undefined;
  until?: Until | undefined;
  ending?: () => boolean;
}

type Until = ReturnType<typeof createUntil>;

// Where a clip's demux stops. `past` says whether the packet in `pkt`, of a stream read, is at or
// after `until` (microseconds) by its dts, and so is every later packet of that stream; `done`
// says whether every stream read has got there.
function createUntil({ core, ctx, pkt }: Media, until: number, streams: number[]) {
  const passed = new Uint8Array(core._sny_nb_streams(ctx));
  const left = { count: streams.length };

  function past(stream: number) {
    if (passed[stream]) return true;
    const [pts, dts] = [core._sny_packet_pts(pkt), core._sny_packet_dts(pkt)];
    const time = dts === AV_NOPTS_VALUE ? pts : dts;
    if (time === AV_NOPTS_VALUE) return false;
    const st = core._sny_stream(ctx, stream);
    const [num, den] = [core._sny_stream_tb_num(st), core._sny_stream_tb_den(st)];
    if ((Number(time) * num * 1e6) / den < until) return false;
    passed[stream] = 1;
    left.count--;
    return true;
  }

  return { past, done: () => left.count === 0 };
}

// Tells the clock in `pcm` how far the placed packets reach, so it runs on past the audio, or
// without any, to the video's end. Without audio, it starts the clock at the first packet's time
// where that is after `from` (seconds), as a late-starting MPEG-TS file needs. It does so before
// that packet is offered, so the render worker sees no earlier clock.
function createReach(
  { core, ctx, pkt }: Media,
  pcm: ReturnType<typeof createPcmProducer>,
  { audio, from }: { audio: boolean; from: number },
): Reach {
  if (!audio) pcm.finish();
  // `end`: how far the packet being offered reaches, in seconds, or -1 without a timestamp.
  const at = { pending: !audio, end: -1 };

  function ahead(stream: number) {
    const [pts, dts] = [core._sny_packet_pts(pkt), core._sny_packet_dts(pkt)];
    const time = pts === AV_NOPTS_VALUE ? dts : pts;
    at.end = -1;
    if (time === AV_NOPTS_VALUE) return;
    const st = core._sny_stream(ctx, stream);
    const num = core._sny_stream_tb_num(st);
    const den = core._sny_stream_tb_den(st);
    const seconds = (Number(time) * num) / den;
    if (at.pending && seconds > from) pcm.start(seconds);
    at.pending = false;
    at.end = seconds + (Number(core._sny_packet_duration(pkt)) * num) / den;
  }

  function placed() {
    if (at.end >= 0) pcm.reach(at.end);
  }

  return { ahead, placed };
}

// Writes the packets of `streams` into `ring`, and its end record once the last is read; decodes
// `audio`'s into its PCM ring as that has room. It returns once the packet ring's consumer
// closes it; once the PCM ring's does, only the audio stops. It waits only when neither ring has
// room: on the PCM ring's doorbell, which both consumers ring, or else the packet ring's.
function pump(m: Media, ring: Ring, streams: number[], pumped: Pumped) {
  const { audio, reach, until, ending = ring.offerEnd } = pumped;
  const { core, check, pkt } = m;
  const ctx = demuxer(m, streams);
  const selected = new Uint8Array(core._sny_nb_streams(ctx));
  for (const s of streams) selected[s] = 1;
  const sleeper = audio ?? ring;
  // `held`: `pkt` holds a packet of `stream` that found no room yet. `armed`: the waiting
  // flags are up, raised before the doorbell was read, so a wait on it misses no room.
  const at = { held: false, stream: 0, eof: false, ended: false, armed: false };

  function arm(on: boolean) {
    const ringFull = (at.held && at.stream !== audio?.stream) || (at.eof && !at.ended);
    ring.waitingForRoom(on && ringFull);
    audio?.wait(on && audio.waiting());
    at.armed = on;
  }

  for (;;) {
    const seen = sleeper.bell();
    let moved = audio?.feed() ?? false;
    // Nothing else to demux once the audio has stopped.
    if (streams.length === 0 && audio?.done()) at.eof = true;

    // Places packets in file order until one finds no room.
    while (!at.eof || at.held) {
      if (!at.held) {
        const ret = core._sny_read(ctx, pkt);

        if (ret === AVERROR_EOF) {
          at.eof = true;
          audio?.end();
          moved = true;
          break;
        }

        check(ret, "read");
        at.stream = core._sny_packet_stream(pkt);
        if (at.stream !== audio?.stream && !selected[at.stream]) continue;
        const past = until?.past(at.stream);

        if (past && until?.done()) {
          at.eof = true;
          audio?.end();
          moved = true;
          break;
        }

        if (past) continue;
        at.held = true;
      }

      const video = at.stream !== audio?.stream;
      if (video) reach?.ahead(at.stream);
      const placed = video ? offer(m, ring, at.stream) : audio.queue(pkt);
      if (placed && video) reach?.placed();

      if (!placed) {
        if (ring.closed()) return arm(false);
        break;
      }

      at.held = false;
      moved = true;
    }

    if (at.eof && !at.ended && !at.held) {
      at.ended = ending();
      if (ring.closed()) return arm(false);
      moved ||= at.ended;
    }

    if (at.ended && (!audio || audio.done())) return arm(false);

    if (moved) {
      if (at.armed) arm(false);
    } else if (at.armed) {
      ring.blocking();
      sleeper.sleep(seen);
      arm(false);
    } else {
      arm(true);
    }
  }
}

// Moves the demuxer to the keyframe of `stream` at or before `from` (microseconds), or to its
// first keyframe when `from` is before it, and returns whether it moved. A demuxer just opened
// is at the start already.
function seek(m: Media, stream: number, from: number) {
  const { core, ctx, check } = m;
  if (from === 0 && !m.read) return false;
  const st = core._sny_stream(ctx, stream);
  const [num, den] = [core._sny_stream_tb_num(st), core._sny_stream_tb_den(st)];
  // Exact, and rounded down, so the keyframe found is never after the target.
  const ts = (BigInt(from) * BigInt(den)) / (BigInt(num) * 1_000_000n);
  let at = ts;

  if (core._sny_seek(ctx, stream, at, AVSEEK_FLAG_BACKWARD) < 0) {
    check(core._sny_seek(ctx, stream, ts, 0), "seek");
    return true;
  }

  // Some demuxers, MP4's among them, seek by dts, so the keyframe found can be due after the
  // target, as an open-GOP CRA is when its leading pictures are due before it; then seek to the
  // keyframe before.
  // This stops at the stream's first keyframe, which a seek before it finds again.
  let previous: bigint | undefined;

  for (;;) {
    const key = firstPacket(m, stream);
    if (key === undefined || key.pts <= ts) break;
    if (previous !== undefined && key.dts >= previous) break;
    previous = key.dts;
    const before = (key.dts < at ? key.dts : at) - 1n;
    if (core._sny_seek(ctx, stream, before, AVSEEK_FLAG_BACKWARD) < 0) break;
    at = before;
  }

  // Back to the keyframe kept, whose packets the reads above passed.
  check(core._sny_seek(ctx, stream, at, AVSEEK_FLAG_BACKWARD), "seek");
  return true;
}

// The pts (or dts, without one) and dts of the next packet of `stream`, read past.
function firstPacket({ core, ctx, check, pkt }: Media, stream: number) {
  for (;;) {
    const ret = core._sny_read(ctx, pkt);
    if (ret === AVERROR_EOF) return undefined;
    check(ret, "read");
    if (core._sny_packet_stream(pkt) !== stream) continue;
    const [pts, dts] = [core._sny_packet_pts(pkt), core._sny_packet_dts(pkt)];
    return { pts: pts === AV_NOPTS_VALUE ? dts : pts, dts: dts === AV_NOPTS_VALUE ? pts : dts };
  }
}

// Runs `pump`, and on an error fails the packet ring, so the thread reading it stops too; the
// error itself goes to whoever asked. `buffered` runs once the audio is buffered ahead.
function demux(m: Media, request: DemuxRequest, buffered: () => void) {
  const { ring, streams, from, pcm, audio } = request;
  const producer = createProducer(ring);
  let decoder: Audio | undefined;

  try {
    if (audio && streams.includes(audio.stream)) {
      throw new RangeError(`demux: stream ${audio.stream} is both demuxed and decoded`);
    }

    demuxer(m, streams);
    if (!Number.isSafeInteger(from) || from < 0) throw new RangeError(`demux: from ${from}`);
    const first = streams[0] ?? audio?.stream;
    const sought = first !== undefined && seek(m, first, from);
    m.read = true;

    if (audio && !pcm) throw new RangeError("demux: audio without a PCM ring");

    if (audio && pcm) {
      const ctx = audioDemuxer(m, audio.stream);
      decoder = createAudio({
        ffmpeg: m,
        ctx,
        stream: audio.stream,
        preroll: audio.preroll,
        pcm,
        from,
        start: sought ? from : undefined,
        until: Infinity,
        buffered,
      });
    }

    const reach =
      pcm && createReach(m, createPcmProducer(pcm), { audio: Boolean(audio), from: from / 1e6 });
    // Without audio, there is none to buffer.
    if (pcm && !audio) buffered();
    pump(m, producer, streams, { audio: decoder, reach });
  } catch (e) {
    producer.fail();
    throw e;
  } finally {
    decoder?.close();
  }
}

interface ClipRead {
  clip: Clip;
  pcm: SharedArrayBuffer;
  // Where the PCM ring's audio is up to on the clock, in microseconds.
  at: number;
  preroll: number;
  buffered: () => void;
}

// Reads `clip` of a track: its video into `ring`, followed by a CUT record, and its audio, or
// silence without any, into the PCM ring up to its end.
function readClip(m: Media, ring: Ring, { clip, pcm, at, preroll, buffered }: ClipRead) {
  const { video, audio, offset } = clip;
  const streams = video === undefined ? [] : [video];
  demuxer(m, streams);
  const first = video ?? audio;
  if (first !== undefined) seek(m, first, clip.in);
  m.read = true;
  const ctx = audio === undefined ? m.ctx : audioDemuxer(m, audio);
  const decoder = createAudio({
    ffmpeg: m,
    ctx,
    stream: audio,
    preroll,
    pcm,
    from: clip.in,
    start: undefined,
    until: clip.out,
    place: { at, offset },
    buffered,
  });

  try {
    // copy: the streams read, the audio among them, once a clip.
    const read = audio === undefined ? streams : [...streams, audio];
    const until = createUntil(m, clip.out, read);
    // A clip without video leaves no record: the render worker reads only the clips with video.
    const ending = video === undefined ? () => true : ring.offerCut;
    pump(m, ring, streams, { audio: decoder, until, ending });
  } finally {
    decoder.close();
  }
}

// Reads a track's clips in turn (src/protocol.ts), on a clock that starts at `from` and runs on
// in silence after the last to `end`; then writes the END record.
function readTrack(m: Media, ring: Ring, request: TrackRequest, buffered: () => void) {
  const { pcm, from, clips, end, preroll } = request;
  const clock = createPcmProducer(pcm);
  clock.start(from / 1e6);
  const at = { time: from };

  for (const clip of clips) {
    readClip(m, ring, { clip, pcm, at: at.time, preroll, buffered });
    if (ring.closed()) return;
    at.time = endOf(clip);
  }

  clock.finish();
  clock.reach(end / 1e6);
  buffered();
  ring.end();
}

// Runs `readTrack`, and on an error fails the packet ring, as `demux` does. `buffered` runs once.
function demuxTrack(m: Media, request: TrackRequest, buffered: () => void) {
  const producer = createProducer(request.ring);
  const told = { buffered: false };

  function once() {
    if (!told.buffered) buffered();
    told.buffered = true;
  }

  try {
    readTrack(m, producer, request, once);
  } catch (e) {
    producer.fail();
    throw e;
  }
}

function createMedia(core: CoreModule) {
  const m = createState(core);
  return {
    open: (file: File) => open(m, file),
    demux: (request: DemuxRequest, buffered: () => void) => demux(m, request, buffered),
    track: (request: TrackRequest, buffered: () => void) => demuxTrack(m, request, buffered),
  };
}

async function startMedia() {
  const core = await createCore();
  return createMedia(core);
}

async function handle(message: ToMedia) {
  const { id } = message;

  try {
    const media = await ready;

    if (message.type === "open") {
      post(Object.assign(media.open(message.file), { type: "opened" as const, id }));
    } else {
      const buffered = () => post({ type: "buffered", id });
      if (message.type === "track") media.track(message, buffered);
      else media.demux(message, buffered);
      post({ type: "demuxed", id });
    }
  } catch (e) {
    post({ type: "error", id, message: e instanceof Error ? e.message : String(e) });
  }
}

// Registered at once: a message that arrives while the module loads waits for it in handle.
self.addEventListener("message", ({ data }: MessageEvent<ToMedia>) => void handle(data));

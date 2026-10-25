// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The media worker: it reads the file and demuxes it with the FFmpeg core module, and decodes
// and resamples its audio. It is the one thread that may block, so it reads the file
// synchronously (src/io.ts) and waits for room in the packet ring (src/ring.ts) and the PCM
// ring (src/pcm.ts).

import {
  AV_NOPTS_VALUE,
  AVINDEX_KEYFRAME,
  AV_TIME_BASE,
  AVSEEK_FLAG_BACKWARD,
  AVERROR_EAGAIN,
  AVERROR_EOF,
  AVMEDIA_TYPE_ATTACHMENT,
  AVMEDIA_TYPE_AUDIO,
  AVMEDIA_TYPE_SUBTITLE,
  AVMEDIA_TYPE_VIDEO,
  type CoreModule,
  createCore,
  type Ptr,
} from "@snowy-media/ffmpeg/core";
import { colorSpace, type VideoParams, WEBCODECS } from "./codec";
import { createFileSource } from "./io";
import { createPcmProducer, pcmFormat } from "./pcm";
import { createProducer } from "./ring";
import type { FromMedia, Opened, ToMedia, Track } from "./protocol";

// The kinds of the other streams; data and an unknown type (-1) are "data".
const OTHER = new Map([
  [AVMEDIA_TYPE_SUBTITLE, "subtitle"],
  [AVMEDIA_TYPE_ATTACHMENT, "attachment"],
] as const);
// Bytes per read: few reads, each one a slice of the file.
const BUFFER = 1 << 22;
// The worker reads one file at a time (src/io.ts), so its one input has a fixed id.
const IO = 1;

// Loading the module starts with the worker, before the first file arrives.
const ready = startMedia();

type AudioRequest = NonNullable<Extract<ToMedia, { type: "demux" }>["audio"]>;

// How many bytes of compressed audio the media worker queues ahead of the PCM ring: minutes of
// AAC or Opus, tens of seconds of FLAC. It lets the demuxer run ahead of the audio clock, to the
// video packets and the end of the file long before they are due.
const AUDIO_AHEAD = 1 << 22;
// What a queued packet costs besides its payload: the AVPacket, its buffer and their padding,
// counted so that small or empty packets are bounded too.
const PACKET_OVERHEAD = 256;
// The frames of silence written at a time, from a buffer of zeros made once.
const SILENCE = 1024;

// An audio stream being decoded into a PCM ring, from a queue of its compressed packets.
interface Audio {
  stream: number;
  /** Moves a packet of the stream out of `pkt` into the queue; false while the queue is full. */
  queue(pkt: Ptr): boolean;
  /** Decodes into the PCM ring as far as it has room; whether anything moved. */
  feed(): boolean;
  /** No more packets come: the decoder drains once the queue is empty. */
  end(): void;
  /** Whether it waits for room in the PCM ring. */
  waiting(): boolean;
  /** Whether all of it is in the PCM ring, or the ring's consumer has closed it. */
  done(): boolean;
  /** The PCM ring's doorbell, which the media worker sleeps on (src/pcm.ts). */
  bell(): number;
  sleep(seen: number): void;
  /** Raises or lowers the PCM ring's waiting flag. */
  wait(on: boolean): void;
  close(): void;
}

function post(message: FromMedia) {
  self.postMessage(message);
}

function createMedia(core: CoreModule) {
  const source = createFileSource(core);
  const str = (ptr: Ptr) => (ptr ? core.UTF8ToString(ptr) : "");
  // The open file's demuxer, or 0, and whether it has read past its start since it opened.
  const state = { ctx: 0, read: false };
  const pkt = core._sny_packet_alloc();

  function check(ret: number, what: string) {
    if (ret < 0) throw new Error(`${what}: ${str(core._sny_strerror(ret))}`);
  }

  function track(id: number): Track {
    const st = core._sny_stream(state.ctx, id);
    const type = core._sny_codec_type(st);
    const codec = str(core._sny_codec_name(st));

    if (type === AVMEDIA_TYPE_VIDEO) {
      const [width, height] = [core._sny_codec_width(st), core._sny_codec_height(st)];
      return { id, kind: "video", codec, width, height };
    }

    if (type === AVMEDIA_TYPE_AUDIO) {
      const [sampleRate, channels] = [
        core._sny_codec_sample_rate(st),
        core._sny_codec_channels(st),
      ];
      return { id, kind: "audio", codec, sampleRate, channels };
    }

    return { id, kind: OTHER.get(type) ?? "data", codec };
  }

  // Stream `id's codec parameters, exported for a module that decodes it.
  function exportParams(id: number) {
    const out = core._malloc(4);
    const size = core._sny_params_export(state.ctx, id, out);
    const at = core.HEAP32[out >>> 2] ?? 0;
    core._free(out);
    check(size, "params_export");
    // copy: out of FFmpeg's memory, which is freed below.
    const params = core.HEAPU8.slice(at, at + size);
    core._free(at);
    return params;
  }

  // What decodes a video stream: a WebCodecs decoder config is made from these (src/codec.ts),
  // or an FFmpeg module opens its decoder with `params`.
  function videoParams(id: number): VideoParams {
    const st = core._sny_stream(state.ctx, id);
    const data = core._sny_codec_extradata(st);
    const tag = core._sny_codec_tag(st);
    const start = core._sny_stream_start_time(st);
    const codec = str(core._sny_codec_name(st));
    const module = str(core._sny_codec_module(state.ctx, id));
    const decoder = WEBCODECS.has(codec)
      ? "webcodecs"
      : module === "video" || module === "video-ext"
        ? module
        : "none";
    return {
      codec,
      decoder,
      params: decoder === "video" || decoder === "video-ext" ? exportParams(id) : new Uint8Array(),
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

  function close() {
    if (state.ctx) core._sny_close(state.ctx);
    state.ctx = 0;
  }

  // Opens `file` in place of the open one and describes it, with its video streams'
  // parameters.
  function open(file: File): Opened {
    close();
    source.open(file);
    const out = core._malloc(4);
    const name = core.stringToNewUTF8(file.name);
    const opened = core._sny_open(IO, BUFFER, name, out);
    const ctx = core.HEAP32[out >>> 2] ?? 0;
    core._free(name);
    core._free(out);
    check(opened, "open");
    state.ctx = ctx;
    state.read = false;
    check(core._sny_find_stream_info(ctx), "find_stream_info");
    const tracks = Array.from({ length: core._sny_nb_streams(ctx) }, (_, i) => track(i));
    const duration = core._sny_duration(ctx);
    const video: Record<number, VideoParams> = {};
    const index: Opened["index"] = {};

    for (const t of tracks) {
      if (t.kind !== "video") continue;
      video[t.id] = videoParams(t.id);
      index[t.id] = keyframes(t.id);
    }

    // AV_NOPTS_VALUE, the only negative duration, is an unknown one.
    const info = {
      format: str(core._sny_format_name(ctx)),
      duration: duration < 0n ? undefined : Number(duration) / AV_TIME_BASE,
      tracks,
    };
    return { info, video, index };
  }

  // The times of stream `id`'s keyframes in its demuxer's index, in microseconds, when they
  // are due or for some demuxers (MP4's) decoded, and of its last entry, up to which the index
  // is known: a fragmented MP4's, for one, holds only the fragments read so far.
  function keyframes(id: number) {
    const st = core._sny_stream(state.ctx, id);
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
  function demuxer(streams: number[]) {
    const { ctx } = state;
    if (!ctx) throw new Error("demux: no file is open");
    const count = core._sny_nb_streams(ctx);

    for (const s of streams) {
      if (!Number.isInteger(s) || s < 0 || s >= count)
        throw new RangeError(`demux: no stream ${s}`);
    }

    return ctx;
  }

  // Decodes audio stream `stream` into PCM ring `pcm`, from the packets `queue` takes, as the
  // ring has room. Once the ring's consumer closes it, the queue takes packets and drops them.
  // `close` frees it all. `buffered` runs once, when the ring holds `preroll` frames, is full,
  // or has all the audio. The audio before `from` (microseconds) is dropped; after a seek
  // (`sought`), silence fills from `from` to where the audio starts, so the clock starts at the
  // target: Opus, for one, drops its first frames after a seek.
  function createAudio(
    { stream, pcm, preroll }: AudioRequest,
    from: number,
    sought: boolean,
    buffered: () => void,
  ): Audio {
    const ctx = demuxer([stream]);
    const st = core._sny_stream(ctx, stream);

    if (core._sny_codec_type(st) !== AVMEDIA_TYPE_AUDIO) {
      throw new RangeError(`demux: stream ${stream} is not audio`);
    }

    // The media worker decodes with the core's decoders alone: a codec in audio-ext fails.
    const module = str(core._sny_codec_module(ctx, stream));
    if (!module) throw new Error(`demux: no module decodes stream ${stream}`);

    if (module !== "core") {
      throw new Error(`demux: stream ${stream} needs the ${module} module, not loaded yet`);
    }

    const { channels, rate } = pcmFormat(pcm);
    const told = { buffered: false, written: 0 };

    function tell() {
      if (!told.buffered) buffered();
      told.buffered = true;
    }

    const producer = createPcmProducer(pcm);
    const [tbNum, tbDen] = [core._sny_stream_tb_num(st), core._sny_stream_tb_den(st)];
    const frame = core._sny_frame_alloc();
    const resampled = core._sny_frame_alloc();
    const resampler = core._sny_resampler_alloc();
    // The packet the decoder last took, kept until the next, so a queue slot is left empty.
    const spent = core._sny_packet_alloc();
    const out = core._malloc(4);
    const allocated = frame && resampled && resampler && spent && out;
    const opened = allocated ? core._sny_decoder_open(ctx, stream, out) : 0;
    const dec = allocated && opened >= 0 ? (core.HEAP32[out >>> 2] ?? 0) : 0;
    core._free(out);
    // The queue: packets in a circle of slots, which doubles when full, so it allocates only
    // as it grows; it is bounded by AUDIO_AHEAD bytes.
    const queued = { slots: [] as Ptr[], head: 0, count: 0, bytes: 0 };
    // The resampled frames not yet in the ring: `left` frames from index `at` of HEAPF32; how
    // many more to drop, as they come before `from`; and the frames of silence before them.
    const pending = { at: 0, left: 0, skip: 0, silence: 0 };
    const zeros = new Float32Array(SILENCE * channels);
    const phase = {
      started: false,
      // No more packets come; the decoder has been sent the end; the resampler is drained.
      ended: false,
      sentEnd: false,
      flushed: false,
      done: false,
      closed: false,
    };

    function free() {
      for (const slot of queued.slots) core._sny_packet_free(slot);
      core._sny_packet_free(spent);
      core._sny_resampler_free(resampler);
      core._sny_frame_free(resampled);
      core._sny_frame_free(frame);
      if (dec) core._sny_decoder_close(dec);
    }

    if (!allocated || opened < 0) {
      free();
      if (!allocated) throw new Error("decoder: out of memory");
      check(opened, "decoder_open");
    }

    function grow() {
      const { slots, head } = queued;
      const more = Array.from({ length: Math.max(8, slots.length) }, () =>
        core._sny_packet_alloc(),
      );

      if (more.includes(0)) {
        for (const slot of more) if (slot) core._sny_packet_free(slot);
        throw new Error("queue: out of memory");
      }

      // copy: only as the queue grows, its slots starting from the head.
      queued.slots = [...slots.slice(head), ...slots.slice(0, head), ...more];
      queued.head = 0;
    }

    function queue(packet: Ptr) {
      if (phase.closed) return true;
      const size = core._sny_packet_size(packet) + PACKET_OVERHEAD;
      if (queued.count > 0 && queued.bytes + size > AUDIO_AHEAD) return false;
      if (queued.count === queued.slots.length) grow();
      const { slots, head, count } = queued;
      core._sny_packet_move(slots[(head + count) % slots.length] ?? 0, packet);
      queued.count++;
      queued.bytes += size;
      return true;
    }

    // Sends the decoder the next queued packet, or the end; false if there is neither yet. A
    // packet the decoder rejects is skipped, as the ffmpeg command line does.
    function send() {
      const { slots, head, count } = queued;

      if (count > 0) {
        const slot = slots[head] ?? 0;
        queued.bytes -= core._sny_packet_size(slot) + PACKET_OVERHEAD;
        core._sny_decoder_send(dec, slot);
        core._sny_packet_move(spent, slot);
        queued.head = (head + 1) % slots.length;
        queued.count--;
        return true;
      }

      if (!phase.ended || phase.sentEnd) return false;
      core._sny_decoder_send(dec, 0);
      phase.sentEnd = true;
      return true;
    }

    // Resamples `input` (0 at the end) into the pending frames.
    function resample(input: Ptr) {
      check(core._sny_resample(resampler, input, resampled, rate, channels), "resample");
      pending.at = core._sny_frame_plane(resampled, 0) >>> 2;
      pending.left = core._sny_frame_samples(resampled);
      const skipped = Math.min(pending.skip, pending.left);
      pending.at += skipped * channels;
      pending.left -= skipped;
      pending.skip -= skipped;
    }

    // Writes pending frames into the ring; false once it is full. A full ring holds a second
    // and more, more than any preroll.
    function write() {
      const silent = pending.silence > 0;
      // HEAPF32 is read for each write: the heap's buffer changes when memory grows.
      const n = silent
        ? producer.offer(zeros, 0, Math.min(pending.silence, SILENCE))
        : producer.offer(core.HEAPF32, pending.at, pending.left);

      if (n < 0) {
        phase.closed = true;
        return true;
      }

      if (n === 0) {
        tell();
        return false;
      }

      if (silent) {
        pending.silence -= n;
      } else {
        pending.at += n * channels;
        pending.left -= n;
      }

      told.written += n;
      if (told.written >= preroll) tell();
      return true;
    }

    function feed() {
      let moved = false;

      while (!phase.closed && !phase.done) {
        if (pending.silence > 0 || pending.left > 0) {
          if (!write()) return moved;
          moved = true;
          continue;
        }

        if (phase.flushed) {
          phase.done = true;
          tell();
          return true;
        }

        const ret = core._sny_decoder_receive(dec, frame);

        if (ret === AVERROR_EOF) {
          resample(0);
          phase.flushed = true;
        } else if (ret === AVERROR_EAGAIN) {
          if (!send()) return moved;
          moved = true;
        } else {
          check(ret, "decoder_receive");

          if (!phase.started) {
            const pts = core._sny_frame_pts(frame);
            const first = pts === AV_NOPTS_VALUE ? 0 : (Number(pts) * tbNum) / tbDen;
            const late = (first - from / 1e6) * rate;
            // Rounded down: the clock starts no later than `from`, so it shows no frame due after.
            pending.skip = Math.max(0, Math.floor(-late));
            pending.silence = sought ? Math.max(0, Math.round(late)) : 0;
            producer.start(sought && late > 0 ? from / 1e6 : first + pending.skip / rate);
            phase.started = true;
          }

          resample(frame);
        }
      }

      // Done or closed counted once, on the pass that got there.
      return moved;
    }

    return {
      stream,
      queue,
      feed,
      end: () => {
        phase.ended = true;
      },
      waiting: () => (pending.silence > 0 || pending.left > 0) && !phase.closed,
      done: () => phase.done || phase.closed,
      bell: producer.bell,
      sleep: producer.sleep,
      wait: producer.waitingForRoom,
      close: free,
    };
  }

  // Writes `pkt`, a packet of stream `stream`, into `ring`; false if it has no room.
  function offer(ring: ReturnType<typeof createProducer>, stream: number) {
    const pts = core._sny_packet_pts(pkt);
    const dts = core._sny_packet_dts(pkt);
    const duration = Number(core._sny_packet_duration(pkt));
    const data = core._sny_packet_data(pkt);
    const size = core._sny_packet_size(pkt);
    const flags = core._sny_packet_flags(pkt);
    // HEAPU8 is read for each packet: the heap's buffer changes when memory grows.
    return ring.offer(stream, flags, pts, dts, duration, core.HEAPU8, data, size);
  }

  // Writes the packets of `streams` into `ring` and queues those of `audio`, decoding them into
  // its PCM ring as that has room, from where the demuxer is to the end of the file. The END
  // record follows the last packet as soon as it is read, and the audio drains after. Returns
  // early once the packet ring's consumer closes it; once the PCM ring's does, the audio stops
  // and the packets go on. It waits only when neither ring has room for what comes next: on the
  // PCM ring's doorbell, which both rings' consumers ring, or with no audio on the packet ring.
  function pump(ring: ReturnType<typeof createProducer>, streams: number[], audio?: Audio) {
    const ctx = demuxer(streams);
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
          at.held = true;
        }

        const placed = at.stream === audio?.stream ? audio.queue(pkt) : offer(ring, at.stream);

        if (!placed) {
          if (ring.closed()) return arm(false);
          break;
        }

        at.held = false;
        moved = true;
      }

      if (at.eof && !at.ended && !at.held) {
        at.ended = ring.offerEnd();
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
  // first keyframe when `from` is before it; whether it moved. A demuxer just opened is at the
  // start already.
  function seek(stream: number, from: number) {
    if (from === 0 && !state.read) return false;
    const st = core._sny_stream(state.ctx, stream);
    const [num, den] = [core._sny_stream_tb_num(st), core._sny_stream_tb_den(st)];
    // Exact, and rounded down, so the keyframe found is never after the target.
    const ts = (BigInt(from) * BigInt(den)) / (BigInt(num) * 1_000_000n);
    let at = ts;

    if (core._sny_seek(state.ctx, stream, at, AVSEEK_FLAG_BACKWARD) < 0) {
      check(core._sny_seek(state.ctx, stream, ts, 0), "seek");
      return true;
    }

    // Some demuxers, MP4's among them, seek by dts, so the keyframe found can be due after the
    // target, as an open-GOP CRA is, its leading pictures before it: then the one before.
    // It stops at the stream's first keyframe, which a seek before it finds again.
    let previous: bigint | undefined;

    for (;;) {
      const key = firstPacket(stream);
      if (key === undefined || key.pts <= ts) break;
      if (previous !== undefined && key.dts >= previous) break;
      previous = key.dts;
      const before = (key.dts < at ? key.dts : at) - 1n;
      if (core._sny_seek(state.ctx, stream, before, AVSEEK_FLAG_BACKWARD) < 0) break;
      at = before;
    }

    // Back to the keyframe kept, whose packets the reads above passed.
    check(core._sny_seek(state.ctx, stream, at, AVSEEK_FLAG_BACKWARD), "seek");
    return true;
  }

  // The pts (or dts, without one) and dts of the next packet of `stream`, read past.
  function firstPacket(stream: number) {
    for (;;) {
      const ret = core._sny_read(state.ctx, pkt);
      if (ret === AVERROR_EOF) return undefined;
      check(ret, "read");
      if (core._sny_packet_stream(pkt) !== stream) continue;
      const [pts, dts] = [core._sny_packet_pts(pkt), core._sny_packet_dts(pkt)];
      return { pts: pts === AV_NOPTS_VALUE ? dts : pts, dts: dts === AV_NOPTS_VALUE ? pts : dts };
    }
  }

  // pump, and on an error fails the ring, so the thread reading it stops too; the
  // error itself goes to whoever asked. `buffered` runs once the audio is buffered ahead.
  function demux(
    ring: SharedArrayBuffer,
    streams: number[],
    from: number,
    audio: AudioRequest | undefined,
    buffered: () => void,
  ) {
    const producer = createProducer(ring);
    let decoder: Audio | undefined;

    try {
      if (audio && streams.includes(audio.stream)) {
        throw new RangeError(`demux: stream ${audio.stream} is both demuxed and decoded`);
      }

      demuxer(streams);
      if (!Number.isSafeInteger(from) || from < 0) throw new RangeError(`demux: from ${from}`);
      const first = streams[0] ?? audio?.stream;
      const sought = first !== undefined && seek(first, from);
      state.read = true;
      if (audio) decoder = createAudio(audio, from, sought, buffered);
      pump(producer, streams, decoder);
    } catch (e) {
      producer.fail();
      throw e;
    } finally {
      decoder?.close();
    }
  }

  return { open, demux };
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
      const { ring, streams, from, audio } = message;
      media.demux(ring, streams, from, audio, buffered);
      post({ type: "demuxed", id });
    }
  } catch (e) {
    post({ type: "error", id, message: e instanceof Error ? e.message : String(e) });
  }
}

// Registered at once: a message that arrives while the module loads waits for it in handle.
self.addEventListener("message", ({ data }: MessageEvent<ToMedia>) => void handle(data));

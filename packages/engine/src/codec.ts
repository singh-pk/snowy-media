// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// WebCodecs decoder configs (docs/architecture.md#video-decoder-configs). The codec string is
// built as each spec below defines it, from the stream's configuration record (avcC, hvcC, av1C),
// which is also the config's `description`, or, where the container has none (MPEG-TS, raw
// streams), from the parameter sets in band.
//
// - H.264: ISO/IEC 14496-15 §5.3.3 and RFC 6381 §3.3, avc1.PPCCLL.
// - HEVC: ISO/IEC 14496-15 Annex E.3, hvc1 or hev1, then profile, compatibility, tier and
//   level, and constraint bytes.
// - VP9: the VP9 codec string spec, vp09.PP.LL.DD, from the keyframe's uncompressed header.
// - AV1: the AV1 ISO-BMFF binding §5, av01.P.LLT.DD.

/**
 * The codecs WebCodecs decodes, by FFmpeg's name; FFmpeg decodes the rest (src/video.worker.ts).
 */
export const WEBCODECS = new Set(["h264", "hevc", "vp8", "vp9", "av1"]);

// FFmpeg's colour names mapped to VideoColorSpace's; a name not listed leaves that field
// unstated. TypeScript's DOM types know fewer of these than Chromium takes (PQ, HLG, BT.2020), so
// they are strings here, checked by the guards below.
const PRIMARIES: Record<string, string> = {
  bt709: "bt709",
  bt470bg: "bt470bg",
  smpte170m: "smpte170m",
  bt2020: "bt2020",
  smpte432: "smpte432",
};
const TRANSFERS: Record<string, string> = {
  bt709: "bt709",
  smpte170m: "smpte170m",
  "iec61966-2-1": "iec61966-2-1",
  linear: "linear",
  // BT.2020's 10- and 12-bit transfer is BT.709's curve.
  "bt2020-10": "bt709",
  "bt2020-12": "bt709",
  smpte2084: "pq",
  "arib-std-b67": "hlg",
};
const MATRICES: Record<string, string> = {
  gbr: "rgb",
  bt709: "bt709",
  bt470bg: "bt470bg",
  smpte170m: "smpte170m",
  bt2020nc: "bt2020-ncl",
};
const isPrimaries = (v = ""): v is VideoColorPrimaries => Object.values(PRIMARIES).includes(v);
const isTransfer = (v = ""): v is VideoTransferCharacteristics =>
  Object.values(TRANSFERS).includes(v);
const isMatrix = (v = ""): v is VideoMatrixCoefficients => Object.values(MATRICES).includes(v);

/**
 * The VideoColorSpace for the colour names FFmpeg gives a stream or frame (`sny_color_*_name`),
 * with only the fields that FFmpeg names and WebCodecs knows.
 */
export function colorSpace(names: {
  primaries: string;
  transfer: string;
  matrix: string;
  range: string;
}): VideoColorSpaceInit {
  const space: VideoColorSpaceInit = {};
  const primaries = PRIMARIES[names.primaries];
  const transfer = TRANSFERS[names.transfer];
  const matrix = MATRICES[names.matrix];
  if (isPrimaries(primaries)) space.primaries = primaries;
  if (isTransfer(transfer)) space.transfer = transfer;
  if (isMatrix(matrix)) space.matrix = matrix;
  if (names.range === "pc" || names.range === "tv") space.fullRange = names.range === "pc";
  return space;
}

/** What the media worker knows of a video stream before decoding it. */
export interface VideoParams {
  /** FFmpeg's codec name. */
  codec: string;
  /**
   * What decodes it: WebCodecs for the codecs in `WEBCODECS`, otherwise the FFmpeg module that
   * holds its decoder, or nothing.
   */
  decoder: "webcodecs" | "video" | "video-ext" | "none";
  /** For an FFmpeg module, the stream's codec parameters as core exports them; else empty. */
  params: Uint8Array;
  /** The container's four-character code, such as "hev1", or "". */
  tag: string;
  /** The codec's configuration record, or parameter sets in band, or nothing. */
  extradata: Uint8Array;
  width: number;
  height: number;
  /** The level the container states, or a negative number when it states none. */
  level: number;
  /** The width of a pixel over its height, as a fraction; 0/1 when unknown. */
  sampleAspect: [number, number];
  /** Its colour, as the container or codec parameters state it (`colorSpace`). */
  colorSpace: VideoColorSpaceInit;
  /** The stream's time base, as a fraction of a second. */
  timeBase: [number, number];
  /** When its first frame is due, in the time base; 0 when unknown. */
  start: number;
  /** FFmpeg's display matrix (src/view.ts), the identity when the stream has none. */
  matrix: number[];
}

const hex = (b: number) => b.toString(16).toUpperCase().padStart(2, "0");
const pad = (n: number) => String(n).padStart(2, "0");

// A bit reader over `data`, most significant bit first.
function createBits(data: Uint8Array) {
  let at = 0;

  function read(n: number) {
    let v = 0;

    for (let i = 0; i < n; i++) {
      v = v * 2 + (((data[at >> 3] ?? 0) >> (7 - (at & 7))) & 1);
      at++;
    }

    return v;
  }

  // AV1's uvlc(): a value of up to 32 bits after as many leading zeros.
  function uvlc() {
    let zeros = 0;
    while (zeros < 32 && read(1) === 0) zeros++;
    return zeros >= 32 ? 2 ** 32 - 1 : read(zeros) + 2 ** zeros - 1;
  }

  return { read, uvlc };
}

// The NAL units of an Annex B stream, without their start codes.
function nalUnits(data: Uint8Array) {
  const starts: number[] = [];

  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      starts.push(i + 3);
      i += 2;
    }
  }

  return starts.map((s, k) => {
    let end = k + 1 < starts.length ? (starts[k + 1] ?? 0) - 3 : data.length;
    // A four-byte start code leaves a zero byte behind.
    while (end > s && data[end - 1] === 0) end--;
    return data.subarray(s, end);
  });
}

// `nal` without its emulation prevention bytes (the 3 of each 00 00 03).
function unescape(nal: Uint8Array) {
  const out: number[] = [];

  for (let i = 0; i < nal.length; i++) {
    const zeros = i >= 2 && nal[i - 1] === 0 && nal[i - 2] === 0;
    if (zeros && nal[i] === 3) continue;
    out.push(nal[i] ?? 0);
  }

  return new Uint8Array(out);
}

// The first NAL unit that `match` accepts, in the extradata and then in the keyframe, both read
// as Annex B; throws if neither has one.
function findNal(p: VideoParams, keyframe: Uint8Array, match: (nal: Uint8Array) => boolean) {
  const found = nalUnits(p.extradata).find(match) ?? nalUnits(keyframe).find(match);
  if (!found) throw new Error(`${p.codec}: no configuration record and no parameter sets`);
  return found;
}

function h264(p: VideoParams, keyframe: Uint8Array): VideoDecoderConfig {
  const record = p.extradata[0] === 1 && p.extradata.length >= 7;
  // avcC copies the SPS's profile, constraint flags and level, the three bytes after its
  // NAL header.
  const ptl = record
    ? p.extradata.subarray(1, 4)
    : findNal(p, keyframe, (nal) => ((nal[0] ?? 0) & 31) === 7 && nal.length >= 4).subarray(1, 4);
  const codec = `avc1.${Array.from(ptl, hex).join("")}`;
  return record ? { codec, description: p.extradata } : { codec };
}

/** The HEVC codec string with `prefix` for the 12-byte general profile_tier_level `ptl`. */
export function hevcCodec(prefix: string, ptl: Uint8Array) {
  const first = ptl[0] ?? 0;
  const space = ["", "A", "B", "C"][first >> 6] ?? "";
  const tier = first & 0x20 ? "H" : "L";
  // The 32 compatibility flags, in reverse bit order.
  const flags =
    (((ptl[1] ?? 0) << 24) | ((ptl[2] ?? 0) << 16) | ((ptl[3] ?? 0) << 8) | (ptl[4] ?? 0)) >>> 0;
  let reversed = 0;
  for (let i = 0; i < 32; i++) reversed = reversed * 2 + ((flags >>> i) & 1);
  const constraints = ptl.subarray(5, 11);
  const kept = constraints.subarray(0, constraints.findLastIndex((b) => b !== 0) + 1);
  const tail = Array.from(kept, (b) => `.${hex(b)}`).join("");
  return `${prefix}.${space}${first & 31}.${reversed.toString(16).toUpperCase()}.${tier}${ptl[11] ?? 0}${tail}`;
}

// Whether an HEVC stream's extradata is a configuration record, with its packets' NAL units
// length-prefixed; if not, they are Annex B. This is FFmpeg's test, which also accepts
// configurationVersion 0, since some writers leave it so.
function hevcRecord(p: VideoParams) {
  const [v = 0, b1 = 0, b2 = 0] = p.extradata;
  return p.extradata.length >= 23 && (v > 0 || b1 > 0 || b2 > 1);
}

/**
 * Whether a packet is an HEVC RASL picture: one that refers to pictures before the CRA it
 * follows, so a decoder starting at that CRA leaves it out (H.265 8.1.3).
 */
export function isRasl(p: VideoParams, data: Uint8Array) {
  if (p.codec !== "hevc") return false;
  // The first picture NAL unit's type, below 32, decides; parameter sets and SEI come before.
  const type = (at: number) => ((data[at] ?? 0) >> 1) & 63;

  if (hevcRecord(p)) {
    const size = ((p.extradata[21] ?? 0) & 3) + 1;

    for (let i = 0; i + size < data.length;) {
      let length = 0;
      for (let k = 0; k < size; k++) length = length * 256 + (data[i + k] ?? 0);
      if (type(i + size) < 32) return type(i + size) === 8 || type(i + size) === 9;
      i += size + length;
    }

    return false;
  }

  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 1) continue;
    if (type(i + 3) < 32) return type(i + 3) === 8 || type(i + 3) === 9;
    i += 2;
  }

  return false;
}

function hevc(p: VideoParams, keyframe: Uint8Array): VideoDecoderConfig {
  if (hevcRecord(p)) {
    const prefix = p.tag === "hev1" ? "hev1" : "hvc1";
    return { codec: hevcCodec(prefix, p.extradata.subarray(1, 13)), description: p.extradata };
  }

  // In band: the SPS's profile_tier_level follows its 2-byte NAL header and one byte of ids.
  const sps = findNal(p, keyframe, (nal) => (((nal[0] ?? 0) >> 1) & 63) === 33);
  return { codec: hevcCodec("hev1", unescape(sps).subarray(3, 15)) };
}

// The smallest VP9 level whose picture size holds `samples` luma samples (VP9 Annex A).
const VP9_LEVELS = [
  [10, 36_864],
  [11, 73_728],
  [20, 122_880],
  [21, 245_760],
  [30, 552_960],
  [31, 983_040],
  [40, 2_228_224],
  [50, 8_912_896],
  [60, 35_651_584],
] as const;

/**
 * The VP9 codec string for a keyframe of a `width` × `height` stream at `level`, or, when
 * `level` is not positive, the smallest level that fits the picture. Throws if `keyframe` is not
 * a VP9 keyframe.
 */
export function vp9Codec(keyframe: Uint8Array, width: number, height: number, level: number) {
  const bits = createBits(keyframe);
  if (bits.read(2) !== 2) throw new Error("vp9: the first packet is not a frame");
  const low = bits.read(1);
  const profile = (bits.read(1) << 1) | low;
  if (profile === 3) bits.read(1);
  // show_existing_frame, then frame_type (0 for a keyframe).
  if (bits.read(1) || bits.read(1)) throw new Error("vp9: the first packet is not a keyframe");
  bits.read(2);
  if (bits.read(24) !== 0x498342) throw new Error("vp9: no keyframe sync code");
  const depth = profile >= 2 ? (bits.read(1) ? 12 : 10) : 8;
  const fit = VP9_LEVELS.find(([, samples]) => width * height <= samples)?.[0] ?? 62;
  return `vp09.${pad(profile)}.${pad(level > 0 ? level : fit)}.${pad(depth)}`;
}

// The AV1 codec string from a sequence header OBU's payload (AV1 §5.5).
function av1SequenceCodec(payload: Uint8Array) {
  const bits = createBits(payload);
  const profile = bits.read(3);
  bits.read(1);
  const reduced = bits.read(1);
  let level = 0;
  let tier = 0;

  if (reduced) {
    level = bits.read(5);
  } else {
    const timing = bits.read(1);
    let decoderModel = 0;
    let delayLength = 0;

    if (timing) {
      bits.read(64);
      if (bits.read(1)) bits.uvlc();
      decoderModel = bits.read(1);

      if (decoderModel) {
        delayLength = bits.read(5) + 1;
        bits.read(32 + 5 + 5);
      }
    }

    const displayDelay = bits.read(1);
    const points = bits.read(5) + 1;

    for (let i = 0; i < points; i++) {
      bits.read(12);
      const seqLevel = bits.read(5);
      const seqTier = seqLevel > 7 ? bits.read(1) : 0;
      if (decoderModel && bits.read(1)) bits.read(2 * delayLength + 1);
      if (displayDelay && bits.read(1)) bits.read(4);

      // The first operating point is the whole stream.
      if (i === 0) {
        level = seqLevel;
        tier = seqTier;
      }
    }
  }

  const widthBits = bits.read(4) + 1;
  const heightBits = bits.read(4) + 1;
  bits.read(widthBits + heightBits);
  if (!reduced && bits.read(1)) bits.read(4 + 3);
  bits.read(3);
  let orderHint = 0;

  if (!reduced) {
    bits.read(4);
    orderHint = bits.read(1);
    if (orderHint) bits.read(2);
  }

  const screenTools = reduced || bits.read(1) ? 2 : bits.read(1);
  if (screenTools > 0 && !reduced && !bits.read(1)) bits.read(1);
  if (orderHint) bits.read(3);
  bits.read(3);
  const high = bits.read(1);
  const depth = high ? (profile === 2 && bits.read(1) ? 12 : 10) : 8;
  return `av01.${profile}.${pad(level)}${tier ? "H" : "M"}.${pad(depth)}`;
}

// The AV1 codec string of the first sequence header OBU in `data`, a sequence of OBUs, if
// it has one.
function av1ObuCodec(data: Uint8Array) {
  let at = 0;

  while (at < data.length) {
    const header = data[at] ?? 0;
    const type = (header >> 3) & 15;
    at += (header >> 2) & 1 ? 2 : 1;
    let size = data.length - at;

    if ((header >> 1) & 1) {
      // The OBU has a size field, as leb128.
      size = 0;

      for (let i = 0; i < 8; i++) {
        const b = data[at++] ?? 0;
        size += (b & 127) * 2 ** (7 * i);
        if (!(b & 128)) break;
      }
    }

    if (type === 1) return av1SequenceCodec(data.subarray(at, at + size));
    at += size;
  }

  return undefined;
}

function av1(p: VideoParams, keyframe: Uint8Array): VideoDecoderConfig {
  const record = p.extradata[0] === 0x81 && p.extradata.length >= 4;

  if (!record) {
    const codec = av1ObuCodec(p.extradata) ?? av1ObuCodec(keyframe);
    if (!codec) throw new Error("av1: no configuration record and no sequence header");
    return { codec };
  }

  const [, b1 = 0, b2 = 0] = p.extradata;
  const profile = b1 >> 5;
  const depth = (b2 >> 6) & 1 ? (profile === 2 && (b2 >> 5) & 1 ? 12 : 10) : 8;
  const codec = `av01.${profile}.${pad(b1 & 31)}${b2 >> 7 ? "H" : "M"}.${pad(depth)}`;
  return { codec, description: p.extradata };
}

/**
 * Whether packet `data` of a stream with parameters `p` makes a frame. A VP8 alt-ref frame,
 * which WebM stores as a packet of its own, is decoded only to be referred to (RFC 6386
 * section 9.1, `show_frame`).
 */
export function makesFrame(p: VideoParams, data: Uint8Array) {
  return p.codec !== "vp8" || ((data[0] ?? 0) & 0x10) !== 0;
}

/**
 * The VideoDecoderConfig of a stream with parameters `p` whose first packet, a keyframe, is
 * `keyframe`. Throws for a codec WebCodecs does not decode, or a stream with neither a
 * configuration record nor parameter sets.
 */
export function videoConfig(p: VideoParams, keyframe: Uint8Array): VideoDecoderConfig {
  const [num, den] = p.sampleAspect;
  const isSquare = !(num > 0 && den > 0 && num !== den);
  // The colour the container states: without it, Chromium takes a VP9 stream, whose bitstream
  // states no transfer, for BT.709 SDR, HDR included. The rest defaults to what FFmpeg assumes,
  // so a frame Chromium converts matches the compositor's (docs/architecture.md#colour).
  // copy: once per stream, the stated colour over the defaults.
  const colour: VideoColorSpaceInit = {
    primaries: "bt709",
    transfer: "bt709",
    matrix: "smpte170m",
    fullRange: false,
    ...p.colorSpace,
  };
  const size = {
    codedWidth: p.width,
    codedHeight: p.height,
    // Non-square pixels make the displayed size differ from the coded size.
    ...(isSquare ? {} : { displayAspectWidth: p.width * num, displayAspectHeight: p.height * den }),
    colorSpace: colour,
    // Without it, Chromium holds more frames than the stream reorders, and in sparse video those
    // wait seconds for the packets that let them out (docs/architecture.md#video-decoder-configs).
    optimizeForLatency: true,
  };
  return Object.assign(codecOf(p, keyframe), size);
}

// The codec string, and the description where the codec has one, for WebCodecs.
function codecOf(p: VideoParams, keyframe: Uint8Array): VideoDecoderConfig {
  if (p.codec === "h264") return h264(p, keyframe);
  if (p.codec === "hevc") return hevc(p, keyframe);
  if (p.codec === "vp9") return { codec: vp9Codec(keyframe, p.width, p.height, p.level) };
  if (p.codec === "vp8") return { codec: "vp8" };
  if (p.codec === "av1") return av1(p, keyframe);
  throw new Error(`${p.codec}: not a codec WebCodecs decodes`);
}

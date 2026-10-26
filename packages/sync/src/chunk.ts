// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The media chunk (docs/architecture.md#media-chunk): a header the source signs, then the
// chunk's packets in decode order. The header carries the body's SHA-256, so one signature
// covers both, and a peer stores a chunk only once both check out. Everything is little-endian;
// timestamps are microseconds on one timeline for every track.
//
// A signed header can never be taken back (the source stores it and never signs that chunk
// again), so encoding refuses any field that would not read back as itself.
//
// On the wire a chunk is sealed with the content key under its object key,
// `media/<track>/<index>`, which travels with it, so a peer can open it before reading the
// header that names its slot.

import {
  keyBytes,
  keyId,
  seal,
  sign,
  unseal,
  verify,
  type Bytes,
  type KeyId,
  type SealedObject,
} from "./crypto";

const VERSION = 1;
// version u8, session [32], track u16, index u32, startUs i64, endUs i64, count u32, bodyHash [32]
const SIGNED = 1 + 32 + 2 + 4 + 8 + 8 + 4 + 32;
const SIG = 64;
/** The header's size: what is signed, then the Ed25519 signature. */
export const HEADER = SIGNED + SIG;
/** The size of a packet record before its bytes. */
export const RECORD = 8 + 8 + 4 + 1 + 4;
const KEYFRAME = 1;
const U16 = 0xffff;
const U32 = 0xffff_ffff;

export type Packet = {
  ptsUs: number;
  dtsUs: number;
  durationUs: number;
  keyframe: boolean;
  data: Uint8Array;
};

export type Chunk = {
  /** The session whose key signed the chunk. */
  session: KeyId;
  track: number;
  index: number;
  /** Inclusive: the pts of the chunk's keyframe. */
  startUs: number;
  /** Exclusive: the next chunk's startUs. */
  endUs: number;
  packets: Packet[];
};

/** Where a chunk belongs: what a peer asked for, and checks it got. */
export type ChunkSlot = { track: number; index: number };

/** Thrown for a chunk that is truncated, misplaced, or fails its hash or signature. */
export class InvalidChunkError extends Error {
  constructor(reason: string) {
    super(`Invalid chunk: ${reason}`);
    this.name = "InvalidChunkError";
  }
}

async function sha256(data: Bytes) {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash);
}

function checkUint(name: string, value: number, max: number) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${name} must be an integer from 0 to ${max}, not ${value}`);
  }
}

function checkTime(name: string, value: number) {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer of microseconds, not ${value}`);
  }
}

// An i64 that doesn't fit a safe integer was never written by encodeChunk.
function readTime(view: DataView, at: number) {
  const value = view.getBigInt64(at, true);

  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new InvalidChunkError("timestamp out of range");
  }

  return Number(value);
}

function encodeBody(packets: Packet[]) {
  const size = packets.reduce((n, p) => n + RECORD + p.data.byteLength, 0);
  const body = new Uint8Array(size);
  const view = new DataView(body.buffer);
  let at = 0;

  for (const [i, p] of packets.entries()) {
    checkTime(`packets[${i}].ptsUs`, p.ptsUs);
    checkTime(`packets[${i}].dtsUs`, p.dtsUs);
    checkUint(`packets[${i}].durationUs`, p.durationUs, U32);
    checkUint(`packets[${i}].data.byteLength`, p.data.byteLength, U32);
    view.setBigInt64(at, BigInt(p.ptsUs), true);
    view.setBigInt64(at + 8, BigInt(p.dtsUs), true);
    view.setUint32(at + 16, p.durationUs, true);
    view.setUint8(at + 20, p.keyframe ? KEYFRAME : 0);
    view.setUint32(at + 21, p.data.byteLength, true);
    body.set(p.data, at + RECORD);
    at += RECORD + p.data.byteLength;
  }

  return body;
}

// Packets view the body in place, without copying.
function decodeBody(body: Bytes, count: number) {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const packets: Packet[] = [];
  let at = 0;

  for (let i = 0; i < count; i++) {
    if (at + RECORD > body.byteLength) throw new InvalidChunkError("truncated packet record");

    const size = view.getUint32(at + 21, true);
    const end = at + RECORD + size;
    if (end > body.byteLength) throw new InvalidChunkError("truncated packet");

    packets.push({
      ptsUs: readTime(view, at),
      dtsUs: readTime(view, at + 8),
      durationUs: view.getUint32(at + 16, true),
      keyframe: (view.getUint8(at + 20) & KEYFRAME) !== 0,
      data: body.subarray(at + RECORD, end),
    });
    at = end;
  }

  if (at !== body.byteLength) throw new InvalidChunkError("bytes after the last packet");
  return packets;
}

/**
 * Cuts a chunk: the header, naming the session the key pair is, signed with its private key,
 * then the body. Throws a `RangeError` for a field that wouldn't read back as itself.
 */
export async function encodeChunk(session: CryptoKeyPair, chunk: Omit<Chunk, "session">) {
  checkUint("track", chunk.track, U16);
  checkUint("index", chunk.index, U32);
  checkTime("startUs", chunk.startUs);
  checkTime("endUs", chunk.endUs);
  checkUint("packets.length", chunk.packets.length, U32);

  const id = await keyId(session.publicKey);
  const body = encodeBody(chunk.packets);
  const bodyHash = await sha256(body);
  const bytes = new Uint8Array(HEADER + body.byteLength);
  const view = new DataView(bytes.buffer);

  view.setUint8(0, VERSION);
  bytes.set(keyBytes(id), 1);
  view.setUint16(33, chunk.track, true);
  view.setUint32(35, chunk.index, true);
  view.setBigInt64(39, BigInt(chunk.startUs), true);
  view.setBigInt64(47, BigInt(chunk.endUs), true);
  view.setUint32(55, chunk.packets.length, true);
  bytes.set(bodyHash, 59);

  const sig = await sign(session.privateKey, bytes.subarray(0, SIGNED));
  bytes.set(sig, SIGNED);
  bytes.set(body, HEADER);
  return bytes;
}

/**
 * Checks that a chunk names the session whose public key is given, is signed by it, holds the
 * body it signed, and is the chunk asked for, then reads it. Rejects with an
 * `InvalidChunkError` for anything that fails: a forwarder can't pass one chunk off as another.
 */
export async function decodeChunk(
  sessionPublicKey: CryptoKey,
  slot: ChunkSlot,
  bytes: Bytes,
): Promise<Chunk> {
  if (bytes.byteLength < HEADER) throw new InvalidChunkError("truncated header");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== VERSION) throw new InvalidChunkError("unknown version");

  const session = await keyId(sessionPublicKey);
  const named = bytes.subarray(1, 33).toBase64({ alphabet: "base64url", omitPadding: true });
  if (named !== session) throw new InvalidChunkError("another session");

  const signed = bytes.subarray(0, SIGNED);
  const valid = await verify(sessionPublicKey, bytes.subarray(SIGNED, HEADER), signed);
  if (!valid) throw new InvalidChunkError("bad signature");

  const track = view.getUint16(33, true);
  const index = view.getUint32(35, true);
  if (track !== slot.track || index !== slot.index) throw new InvalidChunkError("another slot");

  const body = bytes.subarray(HEADER);
  const bodyHash = await sha256(body);
  const signedHash = bytes.subarray(59, SIGNED);
  if (!bodyHash.every((b, i) => b === signedHash[i])) throw new InvalidChunkError("bad body hash");

  return {
    session,
    track,
    index,
    startUs: readTime(view, 39),
    endUs: readTime(view, 47),
    packets: decodeBody(body, view.getUint32(55, true)),
  };
}

/** A chunk's object key: `media/<track>/<index>`. */
export const chunkKey = ({ track, index }: ChunkSlot) => `media/${track}/${index}`;

const CHUNK_KEY = /^media\/(0|[1-9]\d{0,4})\/(0|[1-9]\d{0,9})$/;

/** The slot an object key names, or undefined for a key that isn't a chunk's, spelled as `chunkKey` spells it. */
export function chunkSlot(key: string): ChunkSlot | undefined {
  const [, track, index] = CHUNK_KEY.exec(key) ?? [];
  if (track === undefined || index === undefined) return undefined;
  const slot = { track: Number(track), index: Number(index) };
  return slot.track <= U16 && slot.index <= U32 ? slot : undefined;
}

/**
 * Cuts a chunk as `encodeChunk` does and seals it under its object key, for the source to send.
 * Throws a `RangeError` as `encodeChunk` does.
 */
export async function sealChunk(
  session: CryptoKeyPair,
  content: CryptoKey,
  chunk: Omit<Chunk, "session">,
): Promise<SealedObject> {
  const bytes = await encodeChunk(session, chunk);
  const key = chunkKey(chunk);
  const sealed = await seal(content, key, bytes);
  return { key, sealed };
}

/**
 * Opens a sealed chunk and checks it as `decodeChunk` does, for the slot its object key names.
 * Rejects with an `InvalidChunkError` for a key that isn't a chunk's, bytes that don't open, or a
 * chunk that doesn't check out. A peer stores the sealed bytes, not what this reads.
 */
export async function openChunk(
  sessionPublicKey: CryptoKey,
  content: CryptoKey,
  { key, sealed }: SealedObject,
) {
  const slot = chunkSlot(key);
  if (slot === undefined) throw new InvalidChunkError(`not a chunk key: ${key}`);
  const bytes = await opened(content, key, sealed);
  return decodeChunk(sessionPublicKey, slot, bytes);
}

async function opened(content: CryptoKey, key: string, sealed: Bytes) {
  try {
    return await unseal(content, key, sealed);
  } catch {
    throw new InvalidChunkError("doesn't open");
  }
}

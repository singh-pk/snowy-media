// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The media chunk (src/chunk.ts), in Chromium: a chunk round-trips with its packets; a field that
// wouldn't read back as itself is refused before signing; and a chunk that is truncated,
// altered, signed by or naming another session, or sent for another slot is rejected, as is a
// correctly signed header whose packet records don't match its body. Sealed, a chunk opens under
// the object key its slot names, and one under another key, another content key, or a key that
// isn't a chunk's is rejected.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import {
  chunkKey,
  chunkSlot,
  decodeChunk,
  encodeChunk,
  HEADER,
  InvalidChunkError,
  openChunk,
  RECORD,
  sealChunk,
  type Chunk,
} from "../src/chunk";
import { contentKey, generateKeyPair, keyId, seal, sign, type Bytes } from "../src/crypto";
import { rejection } from "./support/rejection";

const pair = await generateKeyPair();
const session = await keyId(pair.publicKey);
const slot = { track: 3, index: 41 };
const SIGNED = HEADER - 64;

// A keyframe, then a P-frame, then a B-frame shown between them: decode order.
const chunk: Chunk = {
  session,
  ...slot,
  startUs: 82_000_000,
  endUs: 84_002_000,
  packets: [
    {
      ptsUs: 82_000_000,
      dtsUs: 81_958_333,
      durationUs: 41_667,
      keyframe: true,
      data: new Uint8Array([1, 2, 3]),
    },
    {
      ptsUs: 82_083_333,
      dtsUs: 82_000_000,
      durationUs: 41_667,
      keyframe: false,
      data: new Uint8Array([4, 5]),
    },
    {
      ptsUs: 82_041_667,
      dtsUs: 82_041_667,
      durationUs: 41_667,
      keyframe: false,
      data: new Uint8Array([]),
    },
  ],
};

// Changes a valid chunk's bytes, then hashes its body and signs its header again, as a source
// with a bug would: only the checks on the packet records can catch what changed.
async function resigned(change: (bytes: Bytes, view: DataView) => Bytes) {
  const valid = await encodeChunk(pair, chunk);
  const copy = valid.slice();
  const bytes = change(copy, new DataView(copy.buffer));
  const hash = await crypto.subtle.digest("SHA-256", bytes.subarray(HEADER));
  bytes.set(new Uint8Array(hash), 59);
  const sig = await sign(pair.privateKey, bytes.subarray(0, SIGNED));
  bytes.set(sig, SIGNED);
  return bytes;
}

test("a chunk round-trips with its header and packets in decode order", async () => {
  const bytes = await encodeChunk(pair, chunk);
  expect(bytes.byteLength).toBe(HEADER + 3 * RECORD + 5);
  const decoded = await decodeChunk(pair.publicKey, slot, bytes);
  expect(decoded).toEqual(chunk);
});

test("a chunk with no packets round-trips", async () => {
  const empty = { ...chunk, packets: [] };
  const bytes = await encodeChunk(pair, empty);
  const decoded = await decodeChunk(pair.publicKey, slot, bytes);
  expect(decoded).toEqual(empty);
});

test("a chunk read from inside a larger buffer decodes", async () => {
  const bytes = await encodeChunk(pair, chunk);
  const larger = new Uint8Array(bytes.byteLength + 16);
  larger.set(bytes, 8);
  const inside = larger.subarray(8, 8 + bytes.byteLength);
  const decoded = await decodeChunk(pair.publicKey, slot, inside);
  expect(decoded).toEqual(chunk);
});

test("a field that wouldn't read back as itself is refused before signing", async () => {
  const packet = chunk.packets[1]!;
  const bad = [
    { ...chunk, track: 0x1_0000 },
    { ...chunk, index: 2 ** 32 + 5 },
    { ...chunk, index: -1 },
    { ...chunk, startUs: 2 ** 53 + 1 },
    { ...chunk, endUs: 1.5 },
    { ...chunk, packets: [{ ...packet, durationUs: -1 }] },
    { ...chunk, packets: [{ ...packet, ptsUs: Number.NaN }] },
  ];

  for (const fields of bad) {
    const error = await rejection(encodeChunk(pair, fields));
    expect(error).toBeInstanceOf(RangeError);
  }
});

test("a chunk signed by another session is rejected", async () => {
  const other = await generateKeyPair();
  const bytes = await encodeChunk(other, chunk);
  const error = await rejection(decodeChunk(pair.publicKey, slot, bytes));
  expect(error).toBeInstanceOf(InvalidChunkError);
});

test("a chunk naming another session is rejected, even signed by the verifying key", async () => {
  const other = await generateKeyPair();
  const otherId = await keyId(other.publicKey);
  const named = Uint8Array.fromBase64(otherId, { alphabet: "base64url" });
  const bytes = await resigned((b) => {
    b.set(named, 1);
    return b;
  });
  const error = await rejection(decodeChunk(pair.publicKey, slot, bytes));
  expect(error).toEqual(new InvalidChunkError("another session"));
});

test("a chunk sent for another slot is rejected", async () => {
  const bytes = await encodeChunk(pair, chunk);
  const otherIndex = await rejection(decodeChunk(pair.publicKey, { track: 3, index: 42 }, bytes));
  const otherTrack = await rejection(decodeChunk(pair.publicKey, { track: 4, index: 41 }, bytes));
  expect(otherIndex).toEqual(new InvalidChunkError("another slot"));
  expect(otherTrack).toEqual(new InvalidChunkError("another slot"));
});

test("a chunk altered in its header, signature or body is rejected", async () => {
  const bytes = await encodeChunk(pair, chunk);

  // The track, the last byte of the signature, and the first packet's first data byte.
  for (const at of [33, HEADER - 1, HEADER + RECORD]) {
    const altered = bytes.slice();
    altered[at] = (altered[at] ?? 0) ^ 1;
    const error = await rejection(decodeChunk(pair.publicKey, slot, altered));
    expect(error).toBeInstanceOf(InvalidChunkError);
  }
});

test("a chunk of another format version is rejected", async () => {
  const bytes = await encodeChunk(pair, chunk);
  bytes[0] = (bytes[0] ?? 0) + 1;
  const error = await rejection(decodeChunk(pair.publicKey, slot, bytes));
  expect(error).toEqual(new InvalidChunkError("unknown version"));
});

test("a truncated chunk is rejected", async () => {
  const bytes = await encodeChunk(pair, chunk);
  const header = bytes.subarray(0, HEADER - 1);
  const body = bytes.subarray(0, bytes.byteLength - 1);
  const noHeader = await rejection(decodeChunk(pair.publicKey, slot, header));
  const noBody = await rejection(decodeChunk(pair.publicKey, slot, body));
  expect(noHeader).toEqual(new InvalidChunkError("truncated header"));
  expect(noBody).toEqual(new InvalidChunkError("bad body hash"));
});

test("a signed header whose packet records don't match its body is rejected", async () => {
  // One packet more than the body holds.
  const tooMany = await resigned((b, view) => {
    view.setUint32(55, 4, true);
    return b;
  });
  // The last packet claims a byte past the end.
  const tooLong = await resigned((b, view) => {
    view.setUint32(HEADER + 2 * RECORD + 5 + 21, 1, true);
    return b;
  });
  // A byte after the last packet.
  const trailing = await resigned((b) => {
    const longer = new Uint8Array(b.byteLength + 1);
    longer.set(b);
    return longer;
  });
  // A pts beyond the safe integers.
  const farOff = await resigned((b, view) => {
    view.setBigInt64(HEADER, 2n ** 60n, true);
    return b;
  });

  const errors = await Promise.all(
    [tooMany, tooLong, trailing, farOff].map((b) =>
      rejection(decodeChunk(pair.publicKey, slot, b)),
    ),
  );
  expect(errors.map((e) => String(e))).toEqual([
    "InvalidChunkError: Invalid chunk: truncated packet record",
    "InvalidChunkError: Invalid chunk: truncated packet",
    "InvalidChunkError: Invalid chunk: bytes after the last packet",
    "InvalidChunkError: Invalid chunk: timestamp out of range",
  ]);
});

test("a chunk's object key names its slot, in one spelling", () => {
  expect(chunkKey(slot)).toBe("media/3/41");
  expect(chunkSlot("media/3/41")).toEqual(slot);
  expect(chunkSlot("media/65535/4294967295")).toEqual({ track: 65_535, index: 4_294_967_295 });
  const bad = [
    "media/3/041",
    "media/03/41",
    "media/3",
    "media/3/41/",
    "media/-1/41",
    "media/65536/0",
    "media/0/4294967296",
    "media/3/4.5",
    "init/3",
  ];
  expect(bad.map(chunkSlot)).toEqual(bad.map(() => undefined));
});

test("a sealed chunk opens under the key its slot names, and nowhere else", async () => {
  const content = await contentKey(crypto.getRandomValues(new Uint8Array(32)), session);
  const other = await contentKey(crypto.getRandomValues(new Uint8Array(32)), session);
  const object = await sealChunk(pair, content, chunk);
  expect(object.key).toBe("media/3/41");
  const read = await openChunk(pair.publicKey, content, object);
  expect(read).toEqual(chunk);

  // Someone with the content key seals the chunk again under the next slot's key.
  const bytes = await encodeChunk(pair, chunk);
  const resealed = await seal(content, "media/3/42", bytes);
  const errors = await Promise.all([
    rejection(openChunk(pair.publicKey, content, { key: "media/3/42", sealed: object.sealed })),
    rejection(openChunk(pair.publicKey, other, object)),
    rejection(openChunk(pair.publicKey, content, { key: "init/3", sealed: object.sealed })),
    rejection(openChunk(pair.publicKey, content, { key: "media/3/42", sealed: resealed })),
  ]);
  expect(errors).toEqual([
    new InvalidChunkError("doesn't open"),
    new InvalidChunkError("doesn't open"),
    new InvalidChunkError("not a chunk key: init/3"),
    new InvalidChunkError("another slot"),
  ]);
});

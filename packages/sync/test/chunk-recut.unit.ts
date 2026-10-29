// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Cutting a past chunk again at the source (src/chunk-recut.ts), in Chromium: every chunk comes
// back as the bytes first encoded, under the header signed then, whether the demuxer's seek lands
// on the chunk before's keyframe or earlier, and reading stops once it is cut; a file whose
// packets changed, or that ends early, gives nothing; and a chunk not cut yet is refused.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import {
  chunkKey,
  encodeChunk,
  HEADER,
  openChunk,
  type ChunkSlot,
  type Packet,
} from "../src/chunk";
import { createChunkCutter, type CutChunk } from "../src/chunk-cutter";
import { recutChunk } from "../src/chunk-recut";
import { contentKey, generateKeyPair, keyId, unseal, type Bytes } from "../src/crypto";
import { rejection } from "./support/rejection";

const pair = await generateKeyPair();
const sessionId = await keyId(pair.publicKey);
const content = await contentKey(crypto.getRandomValues(new Uint8Array(32)), sessionId);
const S = 1_000_000;
const VIDEO = 0;
const AUDIO = 1;

type Read = readonly [number, Packet];

function at(ptsS: number, keyframe = false, tag = 0): Packet {
  const ptsUs = Math.round(ptsS * S);
  return { ptsUs, dtsUs: ptsUs, durationUs: 40_000, keyframe, data: Uint8Array.of(tag) };
}

// Video keyframes every 1.5 s, so a chunk spans two GOPs and some keyframes start none, with a
// frame between; audio every 0.5 s, stored 0.6 s after the video around it.
function makeFile() {
  const file: Read[] = [];

  for (let i = 0; i < 12; i++) {
    file.push([VIDEO, at(i * 1.5, true, i)], [VIDEO, at(i * 1.5 + 0.75, false, i)]);
    for (const a of [0, 0.5, 1]) if (i * 1.5 + a >= 0.6) file.push([AUDIO, at(i * 1.5 + a - 0.6)]);
  }

  return file;
}

const file = makeFile();

// What the source keeps of the first cut: each chunk's encoded bytes, whose header it stores.
async function firstCut(packets: readonly Read[]) {
  const chunks: CutChunk[] = [];
  const cutter = createChunkCutter({ video: VIDEO, tracks: [AUDIO], cut: (c) => chunks.push(c) });
  for (const [track, packet] of packets) cutter.packet(track, packet);
  cutter.end();
  const encoded = await Promise.all(chunks.map((c) => encodeChunk(pair, c)));
  return new Map(chunks.map((c, i) => [chunkKey(c), encoded[i]!]));
}

const encoded = await firstCut(file);

// A demuxer over `packets`, sought to the latest video keyframe at or before `fromUs`, or with
// `early` the one before that, as a seek index listing only some keyframes would.
function demuxer(packets: readonly Read[], early = false) {
  const seen = { reads: 0, stopped: false, from: [] as Array<number | undefined> };

  async function* read(fromUs: number | undefined) {
    seen.from.push(fromUs);
    const keys = packets.flatMap(([track, p], i) =>
      track === VIDEO && p.keyframe && p.ptsUs <= (fromUs ?? 0) ? [i] : [],
    );
    const start = fromUs === undefined ? 0 : (keys.at(early ? -2 : -1) ?? 0);

    try {
      for (const next of packets.slice(start)) {
        seen.reads++;
        yield next;
      }
    } finally {
      seen.stopped = true;
    }
  }

  return { read, seen };
}

const header = (slot: ChunkSlot) => encoded.get(chunkKey(slot))?.subarray(0, HEADER);

function recut(packets: readonly Read[], slot: ChunkSlot, early = false) {
  const { read, seen } = demuxer(packets, early);
  const sealed = recutChunk({ video: VIDEO, tracks: [AUDIO], content, header, read }, slot);
  return { sealed, seen };
}

const opened = (slot: ChunkSlot, sealed: Bytes) => unseal(content, chunkKey(slot), sealed);

test("every chunk cut again is the bytes first encoded, from an exact seek or an early one", async () => {
  const slots = [...encoded.keys()].map((key) => {
    const [, track, index] = key.split("/").map(Number);
    return { track: track!, index: index! };
  });
  // Six chunks of each track: [0, 3), [3, 6) … [15, 17.29) s.
  expect(slots.length).toBe(12);

  for (const early of [false, true])
    for (const slot of slots) {
      const sealed = await recut(file, slot, early).sealed;
      const bytes = await opened(slot, sealed!);
      expect(bytes).toEqual(encoded.get(chunkKey(slot)));
      const chunk = await openChunk(pair.publicKey, content, {
        key: chunkKey(slot),
        sealed: sealed!,
      });
      expect(chunk.index).toBe(slot.index);
    }
});

test("reading starts at the chunk before's start, or the file's start for chunk 0, and stops once the chunk is cut", async () => {
  const first = recut(file, { track: VIDEO, index: 0 });
  const later = recut(file, { track: VIDEO, index: 2 });
  await Promise.all([first.sealed, later.sealed]);

  expect(first.seen.from).toEqual([undefined]);
  expect(later.seen.from).toEqual([3 * S]);
  expect(later.seen.stopped).toBe(true);
  // From the keyframe at 3 s to the one at 9 s that closes chunk 2: 4 GOPs of 2 frames and audio.
  expect(later.seen.reads).toBeLessThan(file.length / 2);
});

test("a file whose packets changed, or that ends early, gives nothing for the chunks it changed", async () => {
  // The P-frame of the third GOP, at 3.75 s, in video chunk 1.
  const changed = file.map(([track, p]): Read =>
    p.ptsUs === 3_750_000 ? [track, at(3.75, false, 99)] : [track, p],
  );
  const short = file.filter(([, p]) => p.ptsUs < 16 * S);

  const results = await Promise.all([
    recut(changed, { track: VIDEO, index: 1 }).sealed,
    recut(changed, { track: VIDEO, index: 2 }).sealed,
    recut(short, { track: VIDEO, index: 5 }).sealed,
  ]);

  const unchanged = await opened({ track: VIDEO, index: 2 }, results[1]!);

  expect(results[0]).toBeUndefined();
  expect(unchanged).toEqual(encoded.get("media/0/2"));
  expect(results[2]).toBeUndefined();
});

test("a file whose chunk before has no keyframe at its start any more gives nothing", async () => {
  const moved = file.filter(([track, p]) => !(track === VIDEO && p.ptsUs === 3 * S));

  const sealed = await recut(moved, { track: AUDIO, index: 2 }).sealed;

  expect(sealed).toBeUndefined();
});

// Headers as a source holding only `key`'s would give them.
const only = (key: string) => (slot: ChunkSlot) =>
  chunkKey(slot) === key ? header(slot) : undefined;

test("a chunk, or the chunk before it, not cut yet is refused", async () => {
  const { read, seen } = demuxer(file);
  const options = { video: VIDEO, tracks: [AUDIO], content, read };

  const missing = await rejection(
    recutChunk({ ...options, header: only("media/0/0") }, { track: VIDEO, index: 1 }),
  );
  const before = await rejection(
    recutChunk({ ...options, header: only("media/0/2") }, { track: VIDEO, index: 2 }),
  );

  expect(missing).toBeInstanceOf(RangeError);
  expect(before).toBeInstanceOf(RangeError);
  expect(seen.reads).toBe(0);
});

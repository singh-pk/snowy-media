// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Cutting packets into chunks (src/chunk-cutter.ts), in Chromium: video chunks start on a keyframe
// and close at the first one at least 2 s later, keeping leading pictures and dropping what comes
// before the first keyframe; other tracks are cut by pts along the video's bounds, a chunk later,
// leaving out packets too late or too early; and the end cuts every track's last chunk, once,
// ending where the latest packet ends.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import type { Packet } from "../src/chunk";
import { createChunkCutter, type CutChunk } from "../src/chunk-cutter";

const S = 1_000_000;
const VIDEO = 0;
const AUDIO = 1;
const TEXT = 2;

// A packet at `ptsS` seconds lasting `durationS`, decoded in file order; its first byte names it.
function at(ptsS: number, { key = false, durationS = 0.04, tag = 0 } = {}): Packet {
  const ptsUs = Math.round(ptsS * S);
  const data = Uint8Array.of(tag);
  return { ptsUs, dtsUs: ptsUs, durationUs: Math.round(durationS * S), keyframe: key, data };
}

const key = (ptsS: number, tag = 0) => at(ptsS, { key: true, tag });

// Each chunk as `track:index start-end [pts…]`, in seconds, in the order it was cut.
const spell = ({ track, index, startUs, endUs, packets }: CutChunk) =>
  `${track}:${index} ${startUs / S}-${endUs / S} [${packets.map((p) => p.ptsUs / S).join(" ")}]`;

function cutter(tracks = [AUDIO, TEXT]) {
  const cut: string[] = [];
  const chunks: CutChunk[] = [];
  const { packet, end } = createChunkCutter({
    video: VIDEO,
    tracks,
    cut: (chunk) => {
      chunks.push(chunk);
      cut.push(spell(chunk));
    },
  });
  return { packet, end, cut, chunks };
}

test("a video chunk closes at the first keyframe at least 2 s past its start", () => {
  const { packet, end, cut } = cutter([]);
  for (const p of [
    key(0),
    at(1),
    key(1.5),
    key(1.999999),
    at(2.05),
    key(2),
    at(3),
    key(3.5),
    key(4.2),
  ])
    packet(VIDEO, p);
  end();

  expect(cut).toEqual([
    "0:0 0-2 [0 1 1.5 1.999999 2.05]",
    "0:1 2-4.2 [2 3 3.5]",
    "0:2 4.2-4.24 [4.2]",
  ]);
});

test("pictures after a keyframe in decode order stay with it, whatever their pts", () => {
  const { packet, end, cut } = cutter([]);
  for (const p of [key(0), at(1), key(2.2), at(2.1), at(2.15), at(2.3)]) packet(VIDEO, p);
  end();

  expect(cut).toEqual(["0:0 0-2.2 [0 1]", "0:1 2.2-2.34 [2.2 2.1 2.15 2.3]"]);
});

test("video before the first keyframe is left out, and the first chunk starts at it", () => {
  const { packet, end, cut } = cutter([]);
  for (const p of [at(0, { durationS: 1 }), at(0.04), key(0.5), at(0.6)]) packet(VIDEO, p);
  end();

  expect(cut).toEqual(["0:0 0.5-0.64 [0.5 0.6]"]);
});

test("a file with no video keyframe cuts nothing", () => {
  const { packet, end, cut } = cutter();
  packet(VIDEO, at(0));
  packet(AUDIO, at(0));
  end();

  expect(cut).toEqual([]);
});

test("another track's chunk holds its packets by pts, in file order, cut once the next video chunk closes", () => {
  const { packet, end, cut } = cutter([AUDIO]);
  packet(VIDEO, key(0));
  packet(AUDIO, at(0));
  packet(AUDIO, at(1.9));
  packet(VIDEO, key(2));
  // Stored after the keyframe that closed its chunk, as files may.
  packet(AUDIO, at(1.98));
  packet(AUDIO, at(2));
  expect(cut).toEqual(["0:0 0-2 [0]"]);

  packet(VIDEO, key(4));
  expect(cut).toEqual(["0:0 0-2 [0]", "0:1 2-4 [2]", "1:0 0-2 [0 1.9 1.98]"]);

  packet(AUDIO, at(4.5, { durationS: 0.5 }));
  end();

  expect(cut.slice(3)).toEqual(["0:2 4-5 [4]", "1:1 2-4 [2]", "1:2 4-5 [4.5]"]);
});

test("another track's packet whose chunk is cut already, or before the first chunk, is left out", () => {
  const { packet, end, cut } = cutter([AUDIO]);
  packet(AUDIO, at(0.5));
  // Stored before the video keyframe it starts with.
  packet(AUDIO, at(1));
  packet(VIDEO, key(1));
  packet(AUDIO, at(0.9));
  packet(AUDIO, at(1.5));
  packet(VIDEO, key(3));
  packet(VIDEO, key(5));
  packet(AUDIO, at(2.9, { durationS: 10 }));
  packet(AUDIO, at(3));
  end();

  expect(cut.filter((c) => c.startsWith("1:"))).toEqual([
    "1:0 1-3 [1 1.5]",
    "1:1 3-5 [3]",
    "1:2 5-5.04 []",
  ]);
});

test("a track with no packets gets an empty chunk at every index", () => {
  const { packet, end, cut } = cutter([TEXT]);
  for (const p of [key(0), key(2), key(4)]) packet(VIDEO, p);
  end();

  expect(cut.filter((c) => c.startsWith("2:"))).toEqual([
    "2:0 0-2 []",
    "2:1 2-4 []",
    "2:2 4-4.04 []",
  ]);
});

test("the last chunk ends where the latest packet of any track ends, one with no duration a microsecond on", () => {
  const audio = cutter([AUDIO]);
  audio.packet(VIDEO, key(0));
  audio.packet(AUDIO, at(0.5, { durationS: 1 }));
  audio.end();

  const still = cutter([]);
  still.packet(VIDEO, at(0, { key: true, durationS: 0 }));
  still.end();

  expect(audio.cut).toEqual(["0:0 0-1.5 [0]", "1:0 0-1.5 [0.5]"]);
  expect(still.chunks.map((c) => c.endUs)).toEqual([1]);
});

test("the end cuts once, and packets after it or of tracks not cut are left out", () => {
  const { packet, end, cut, chunks } = cutter([AUDIO]);
  packet(VIDEO, key(0, 7));
  packet(TEXT, at(0.1));
  packet(AUDIO, at(0.2, { tag: 8 }));
  end();
  packet(VIDEO, key(5));
  packet(AUDIO, at(2.5));
  end();

  expect(cut).toEqual(["0:0 0-0.24 [0]", "1:0 0-0.24 [0.2]"]);
  expect(chunks.map((c) => c.packets.map((p) => p.data[0]))).toEqual([[7], [8]]);
});

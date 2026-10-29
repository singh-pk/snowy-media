// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The source's cut of its file (docs/architecture.md#media-at-the-source): each chunk the cutter
// gives is signed once and only its header kept, with its sealed size for the index. An index
// counts as cut once every track's chunk of it is kept, since sending any of them cuts it again
// from its header. After a reload, cutting carries on from what is kept, signing nothing twice.

import { encodeChunk, HEADER, type ChunkSlot, type Packet } from "./chunk";
import { createChunkCutter, type CutChunk } from "./chunk-cutter";
import { sealedSize, type Bytes } from "./crypto";

/** What the source keeps of a chunk: its signed header, and how many bytes it is sealed. */
export type KeptChunk = { header: Bytes; bytes: number };

export type SourceCutOptions = {
  session: CryptoKeyPair;
  /** The video track, whose keyframes bound every chunk. */
  video: number;
  /** The audio and subtitle tracks. */
  tracks: number[];
  /** As `recutChunk` takes it (src/chunk-recut.ts). */
  read(fromUs: number | undefined): AsyncIterable<readonly [number, Packet]>;
  /** What an earlier cut kept of a chunk, which isn't signed or kept again. */
  kept(slot: ChunkSlot): KeptChunk | undefined;
  /** Keeps what the source keeps of a chunk; cutting waits for it. */
  keep(slot: ChunkSlot, chunk: KeptChunk): Promise<void>;
  /** An index is cut in every track: `[startUs, endUs)`, its video chunk `bytes` long sealed. */
  indexed(cut: { index: number; startUs: number; endUs: number; bytes: number }): void;
  /**
   * After a reload, the last index every track's chunk of which is kept, and its `startUs`:
   * cutting carries on after it, and the indexes up to it are the caller's to report.
   */
  from?: { index: number; startUs: number } | undefined;
};

async function kept(options: SourceCutOptions, chunk: CutChunk) {
  const slot = { track: chunk.track, index: chunk.index };
  const held = options.kept(slot);
  if (held !== undefined) return held.bytes;
  const encoded = await encodeChunk(options.session, chunk);
  // copy: the header alone, kept without the body it was signed with.
  const header = encoded.slice(0, HEADER);
  const bytes = sealedSize(encoded.byteLength);
  await options.keep(slot, { header, bytes });
  return bytes;
}

/**
 * Cuts the file to its end. Resolves with how many indexes it has, or undefined when it has no
 * video keyframe, or none at `from.startUs`: it has changed. Rejects with what `read`, `keep` or
 * `indexed` throws, leaving what is kept so far for cutting to carry on from, and with a
 * `RangeError` for `tracks` the cutter refuses or a packet a chunk can't hold.
 */
export async function cutSource(options: SourceCutOptions) {
  const { video, tracks, from } = options;
  const cut: CutChunk[] = [];
  const cutter = createChunkCutter({ video, tracks, from, cut: (chunk) => cut.push(chunk) });
  // Each index not yet whole: how many of its tracks' chunks are kept, and its video's size.
  const whole = new Map<number, { kept: number; bytes: number }>();
  const state = { count: (from?.index ?? -1) + 1 };

  async function keepCut() {
    for (let chunk = cut.shift(); chunk !== undefined; chunk = cut.shift()) {
      const bytes = await kept(options, chunk);
      const { index, startUs, endUs } = chunk;
      const sofar = whole.get(index) ?? { kept: 0, bytes: 0 };
      sofar.kept++;
      if (chunk.track === video) sofar.bytes = bytes;
      whole.set(index, sofar);
      if (sofar.kept <= tracks.length) continue;
      whole.delete(index);
      options.indexed({ index, startUs, endUs, bytes: sofar.bytes });
      state.count = index + 1;
    }
  }

  for await (const [track, packet] of options.read(from?.startUs)) {
    if (!cutter.packet(track, packet)) return undefined;
    await keepCut();
  }

  const ended = cutter.end();
  await keepCut();
  return ended ? state.count : undefined;
}

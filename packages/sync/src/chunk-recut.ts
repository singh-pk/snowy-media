// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Cutting a past chunk again at the source, which keeps only each chunk's signed header
// (docs/architecture.md#the-sources-file). The cutter, started from the chunk before, gives the
// chunk as it first came; it goes out joined to the header signed then, sealed again, only if
// its body is the one that header signed.

import { chunkKey, chunkStartUs, joinChunk, sameSlot, type ChunkSlot, type Packet } from "./chunk";
import { createChunkCutter } from "./chunk-cutter";
import { seal, type Bytes } from "./crypto";

export type ChunkRecutOptions = {
  /** The tracks the file was first cut with: its video track and the others. */
  video: number;
  tracks: number[];
  content: CryptoKey;
  /** The header signed when a chunk was first cut, or undefined for one not cut yet. */
  header(slot: ChunkSlot): Bytes | undefined;
  /**
   * The file's packets in file order, as `[track, packet]`, from the demuxer sought to or before
   * `fromUs`, or from the file's start when it is undefined. Reading stops, through the
   * iterator's `return`, once the chunk is cut.
   */
  read(fromUs: number | undefined): AsyncIterable<readonly [number, Packet]>;
};

type From = { index: number; startUs: number } | undefined;

async function packetsOf(options: ChunkRecutOptions, slot: ChunkSlot, from: From) {
  const found = { packets: undefined as Packet[] | undefined };
  const cutter = createChunkCutter({
    video: options.video,
    tracks: options.tracks,
    from,
    cut: (chunk) => {
      if (sameSlot(chunk, slot)) found.packets = chunk.packets;
    },
  });

  for await (const [track, packet] of options.read(from?.startUs)) {
    cutter.packet(track, packet);
    if (found.packets) return found.packets;
  }

  cutter.end();
  return found.packets;
}

/**
 * A past chunk cut again from the file and sealed under its object key, or undefined when the
 * file no longer gives the body its header signed: the file has changed. Throws a `RangeError`
 * for a chunk, or the chunk before it, not cut yet.
 */
export async function recutChunk(options: ChunkRecutOptions, slot: ChunkSlot) {
  const { track, index } = slot;
  const header = options.header(slot);
  // Chunk 0 is cut from the file's start, any other from the keyframe starting the one before.
  const before = index === 0 ? undefined : options.header({ track, index: index - 1 });
  if (header === undefined || (index > 0 && before === undefined))
    throw new RangeError(`${chunkKey(slot)} isn't cut yet`);
  const from = before && { index: index - 1, startUs: chunkStartUs(before) };
  const packets = await packetsOf(options, slot, from);
  if (packets === undefined) return undefined;
  const bytes = await joinChunk(header, packets);
  return bytes && seal(options.content, chunkKey(slot), bytes);
}

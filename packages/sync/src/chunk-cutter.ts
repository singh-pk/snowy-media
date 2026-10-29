// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Cutting a file's packets into chunks, in the order the demuxer reads them
// (docs/architecture.md#demuxing-and-cutting-chunks). The video track sets every chunk's bounds:
// a chunk starts on a keyframe and closes at the first keyframe at least 2 s later, keeping the
// packets between in decode order, leading pictures included. Each other track's chunk of an
// index holds that track's packets whose pts falls in the chunk's range.

import type { Chunk, Packet } from "./chunk";

// The shortest video chunk: one closes at the first keyframe at least this far past its start.
const MIN_CHUNK_US = 2_000_000;

export type CutChunk = Omit<Chunk, "session">;

export type ChunkCutterOptions = {
  /** The track whose keyframes bound every chunk. */
  video: number;
  /** The audio and subtitle tracks, cut along the video's bounds. */
  tracks: number[];
  /**
   * A chunk is cut. Each track's chunks come in index order, and another track's chunk of an
   * index once the video has closed the next one.
   */
  cut(chunk: CutChunk): void;
};

export function createChunkCutter(options: ChunkCutterOptions) {
  // Each video chunk's start, the open one's last; once cutting ends, then the last one's end.
  const bounds: number[] = [];
  const held = new Map(options.tracks.map((track) => [track, [] as Packet[]]));
  const state = { video: [] as Packet[], others: 0, endUs: 0, ended: false };

  function cutOthers(index: number) {
    const startUs = bounds[index]!;
    const endUs = bounds[index + 1]!;

    for (const [track, packets] of held) {
      const kept = packets.filter((p) => p.ptsUs >= startUs && p.ptsUs < endUs);
      const later = packets.filter((p) => p.ptsUs >= endUs);
      held.set(track, later);
      options.cut({ track, index, startUs, endUs, packets: kept });
    }

    state.others = index + 1;
  }

  // A file may store a track's packets well after the video around them, so another track's
  // chunk is cut only once a whole chunk more of video has gone by.
  function closeVideo(endUs: number) {
    const index = bounds.length - 1;
    const startUs = bounds[index]!;
    bounds.push(endUs);
    options.cut({ track: options.video, index, startUs, endUs, packets: state.video });
    state.video = [];
    if (index > 0) cutOthers(index - 1);
  }

  function videoPacket(read: Packet) {
    const startUs = bounds.at(-1);

    // What comes before the first keyframe can't be decoded.
    if (startUs === undefined) {
      if (!read.keyframe) return false;
      bounds.push(read.ptsUs);
    } else if (read.keyframe && read.ptsUs >= startUs + MIN_CHUNK_US) closeVideo(read.ptsUs);

    state.video.push(read);
    return true;
  }

  function otherPacket(track: number, read: Packet) {
    const packets = held.get(track);
    if (packets === undefined || read.ptsUs < (bounds[state.others] ?? -Infinity)) return false;
    packets.push(read);
    return true;
  }

  /**
   * A packet the demuxer read, in file order. A packet of a track not cut, of video before its
   * first keyframe, or of another track whose chunk is cut already or would start before the
   * first chunk, is left out.
   */
  function packet(track: number, read: Packet) {
    if (state.ended) return;
    const kept = track === options.video ? videoPacket(read) : otherPacket(track, read);
    if (!kept) return;
    // A packet with no duration still lasts until the next microsecond.
    state.endUs = Math.max(state.endUs, read.ptsUs + Math.max(read.durationUs, 1));
  }

  /**
   * The file has ended: the last chunk of every track is cut, ending where the latest packet
   * ends. Nothing is cut from a file with no video keyframe.
   */
  function end() {
    if (state.ended) return;
    state.ended = true;
    if (bounds.length === 0) return;
    closeVideo(state.endUs);
    cutOthers(bounds.length - 2);
  }

  return { packet, end };
}

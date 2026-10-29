// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Cutting a file's packets into chunks, in the order the demuxer reads them
// (docs/architecture.md#demuxing-and-cutting-chunks). The video track sets every chunk's bounds:
// a chunk starts on a keyframe and closes at the first keyframe at least 2 s later, keeping the
// packets between in decode order, leading pictures included. Each other track's chunk of an
// index holds that track's packets whose pts falls in the chunk's range, read in the window a
// chunk cut again reads too.

import type { Chunk, Packet } from "./chunk";

const MIN_CHUNK_US = 2_000_000;

export type CutChunk = Omit<Chunk, "session">;

export type ChunkCutterOptions = {
  /** The track whose keyframes bound every chunk. */
  video: number;
  /** The audio and subtitle tracks, cut along the video's bounds; not `video`, each once. */
  tracks: number[];
  /**
   * A chunk is cut. Each track's chunks come in index order, and another track's chunk of an
   * index once the video has closed the next one.
   */
  cut(chunk: CutChunk): void;
  /**
   * To cut past chunks again, from the demuxer sought to or before the video keyframe at
   * `startUs`, which starts chunk `index`: cutting starts at that keyframe, and every chunk after
   * `index` comes out as it first did. Chunk `index` itself isn't cut.
   */
  from?: { index: number; startUs: number } | undefined;
};

// A packet of another track, with the video chunk that was open when it was read: one before
// the first, before the first keyframe.
type Held = { packet: Packet; read: number };

// One with no duration still lasts until the next microsecond.
const ends = ({ ptsUs, durationUs }: Packet) => ptsUs + Math.max(durationUs, 1);

export function createChunkCutter(options: ChunkCutterOptions) {
  const { video, tracks, from } = options;

  if (tracks.includes(video) || new Set(tracks).size !== tracks.length)
    throw new RangeError("tracks must name each track once, and not the video track");

  const first = from?.index ?? 0;
  const starts: number[] = [];
  const held = new Map(tracks.map((track) => [track, [] as Held[]]));
  const state = { video: [] as Packet[], ended: false };
  const open = () => first + starts.length - 1;

  // Chunk `index` of another track takes what was read from the keyframe starting the chunk
  // before it, where a chunk cut again starts reading, or from the file's start for chunk 0: what
  // was read before that goes once the chunk before is cut.
  function cutOthers(index: number) {
    const startUs = starts[index - first]!;
    const endUs = starts[index + 1 - first]!;

    for (const [track, packets] of held) {
      const kept: Packet[] = [];
      const later: Held[] = [];

      for (const one of packets) {
        const { ptsUs } = one.packet;
        if (ptsUs >= startUs && ptsUs < endUs) kept.push(one.packet);
        else if (ptsUs >= endUs && one.read >= index) later.push(one);
      }

      held.set(track, later);
      if (from === undefined || index > first)
        options.cut({ track, index, startUs, endUs, packets: kept });
    }
  }

  // A file may store a track's packets well after the video around them, so another track's
  // chunk is cut only once a whole chunk more of video has gone by.
  function closeVideo(endUs: number) {
    const index = open();
    const startUs = starts.at(-1)!;
    starts.push(endUs);
    if (from === undefined || index > first)
      options.cut({ track: video, index, startUs, endUs, packets: state.video });
    state.video = [];
    if (index > first) cutOthers(index - 1);
  }

  function videoPacket(read: Packet) {
    const startUs = starts.at(-1);

    // What comes before the first keyframe can't be decoded.
    if (startUs === undefined) {
      if (!read.keyframe || (from !== undefined && read.ptsUs !== from.startUs)) return;
      starts.push(read.ptsUs);
    } else if (read.keyframe && read.ptsUs >= startUs + MIN_CHUNK_US) closeVideo(read.ptsUs);

    state.video.push(read);
  }

  /**
   * A packet the demuxer read, in file order. Video before the first keyframe, and packets of a
   * track not cut, are left out, as are another track's packets read too late or too early for
   * the chunk their pts falls in.
   */
  function packet(track: number, read: Packet) {
    if (state.ended) return;
    if (track === video) videoPacket(read);
    // Read before cutting starts, it could only be in chunk `from.index`, which isn't cut.
    else if (from === undefined || starts.length > 0)
      held.get(track)?.push({ packet: read, read: open() });
  }

  function lastEnd() {
    const last = open();
    const startUs = starts.at(-1)!;
    const latest = { us: 0 };
    for (const one of state.video) latest.us = Math.max(latest.us, ends(one));

    for (const packets of held.values())
      for (const { packet: one, read } of packets)
        if (one.ptsUs >= startUs && read >= last - 1) latest.us = Math.max(latest.us, ends(one));

    return latest.us;
  }

  /**
   * The file has ended: the last chunk of every track is cut, ending where the latest packet in
   * it ends. Returns false when no video keyframe came, or none at `from.startUs`, so nothing
   * was cut; true otherwise, and on every call after the first.
   */
  function end() {
    if (state.ended) return true;
    state.ended = true;
    if (starts.length === 0) return false;
    const last = open();
    closeVideo(lastEnd());
    cutOthers(last);
    return true;
  }

  return { packet, end };
}

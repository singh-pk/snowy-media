// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A demuxed file for the source's tests: its packets in file order, and a demuxer over them that
// seeks to a keyframe at or before a time and counts what it reads.

import type { Packet } from "../../src/chunk";

export const S = 1_000_000;
export const VIDEO = 0;
export const AUDIO = 1;

export type Read = readonly [number, Packet];

export function at(ptsS: number, keyframe = false, tag = 0): Packet {
  const ptsUs = Math.round(ptsS * S);
  return { ptsUs, dtsUs: ptsUs, durationUs: 40_000, keyframe, data: Uint8Array.of(tag) };
}

// Video keyframes every 1.5 s, so a chunk spans two GOPs and some keyframes start none, with a
// frame between; audio every 0.5 s, each packet a keyframe as audio's are, stored 0.6 s ahead
// of the video around it. Six chunks of each track: [0, 3), [3, 6) … [15, 18.14) s.
function makeFile() {
  const file: Read[] = [];

  for (let i = 0; i < 12; i++) {
    file.push([VIDEO, at(i * 1.5, true, i)], [VIDEO, at(i * 1.5 + 0.75, false, i)]);
    for (const a of [0, 0.5, 1]) file.push([AUDIO, at(i * 1.5 + a + 0.6, true)]);
  }

  return file;
}

export const file: readonly Read[] = makeFile();

/**
 * A demuxer over `packets`, sought to the latest video keyframe at or before `fromUs`, or with
 * `early` the one before that, as a seek index listing only some keyframes would. `seen` counts
 * what it reads, the times it was sought to, and whether reading stopped before the end.
 */
export function demuxer(packets: readonly Read[], early = false) {
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
      seen.stopped = seen.reads < packets.length - start;
    }
  }

  return { read, seen };
}

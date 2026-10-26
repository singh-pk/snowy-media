// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A project to apply operations to in tests (src/project.ts), and the operations they build on.

import type { Batch } from "../../src/batch";
import type { ItemRecord } from "../../src/document";
import { createProject } from "../../src/project";

export type Op = Batch["ops"][number];

export const SECOND = 705_600_000;
export const FRAME = SECOND / 24;
export const author = "A".repeat(43);
export const id = (seq: number, index: number) => `${author}.${seq}.${index}`;
export const sequence = id(1, 0);
export const video = id(1, 1);
export const audio = id(1, 2);
export const asset = "Q".repeat(43);

// A project with a 24 fps sequence, a video and an audio role, and an asset with a video
// stream in 1/24000 and an audio stream in 1/48000.
export function setUp() {
  const project = createProject();
  const ops: Op[] = [
    {
      op: "sequence.add",
      sequence: { name: "Main", rate: [24, 1], width: 1920, height: 1080, sampleRate: 48_000 },
    },
    {
      op: "role.add",
      role: { sequence, name: "Video", kind: "video", color: "#3366ff", order: "a0" },
    },
    {
      op: "role.add",
      role: { sequence, name: "Music", kind: "audio", color: "#33cc66", order: "a1" },
    },
    {
      op: "asset.add",
      asset: {
        id: asset,
        size: 1000,
        head: "E".repeat(43),
        tail: "I".repeat(43),
        name: "a.mp4",
        streams: [
          { index: 0, kind: "video", timeBase: [1, 24_000], start: 0, duration: 60 * 24_000 },
          { index: 1, kind: "audio", timeBase: [1, 48_000], start: 0, duration: 60 * 48_000 },
        ],
      },
    },
  ];
  const { skipped } = project.apply({ author, seq: 1, ops });
  if (skipped.length > 0) throw new Error(`setting up skipped ${JSON.stringify(skipped)}`);
  let seq = 1;

  function apply(...more: Op[]) {
    seq += 1;
    return { seq, ...project.apply({ author, seq, ops: more }) };
  }

  return { project, apply };
}

/** A second sequence, Inner, and a video role of it: the first two operations of batch `seq`. */
export const innerSequence = (seq: number): Op[] => [
  {
    op: "sequence.add",
    sequence: { name: "Inner", rate: [24, 1], width: 1920, height: 1080, sampleRate: 48_000 },
  },
  {
    op: "role.add",
    role: { sequence: id(seq, 0), name: "V", kind: "video", color: "#000000", order: "a0" },
  },
];

export function clip(changes: Partial<Extract<ItemRecord, { kind: "clip" }>> = {}): Op {
  return {
    op: "item.add",
    item: {
      kind: "clip",
      source: { asset, stream: 0 },
      in: 0,
      duration: SECOND,
      speed: [1, 1],
      anchor: { storyline: sequence, position: "a0" },
      role: video,
      lane: 0,
      enabled: true,
      ...changes,
    },
  };
}

export const at = (position: string) => ({ storyline: sequence, position });

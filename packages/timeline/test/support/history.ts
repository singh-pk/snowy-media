// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Peers that sign batches, and histories of main, for tests of src/history.ts and
// src/branches.ts.

import { batchHash, keyIdOf, signBatch } from "../../src/batch";
import { createHistory } from "../../src/history";
import type { Op } from "./project";

type EntryRef = { n: number; hash: string };
type BatchRef = { author: string; seq: number };

// What a peer signs a batch with; the rest follows from its batches before.
type Commit = {
  branch: string;
  ops: Op[];
  hlc: string;
  base?: EntryRef | undefined;
  undoes?: BatchRef | undefined;
};

export const generate = () => crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);

/** A peer that signs its batches in order, by default on `main`. */
export async function author() {
  const peer = await generate();
  const key = await keyIdOf(peer.publicKey);
  const hashes: string[] = [];
  // The seq of the peer's last batch on each branch.
  const lastOn = new Map<string, number>();

  async function sign({ branch, ops, hlc, base = { n: 0, hash: "" }, undoes }: Commit) {
    const seq = hashes.length + 1;
    const batch = await signBatch(peer, {
      author: key,
      seq,
      prev: hashes.at(-1) ?? "",
      branch,
      branchPrev: lastOn.get(branch) ?? 0,
      base,
      hlc,
      label: "Edit",
      ...(undoes === undefined ? {} : { undoes }),
      ops,
    });
    const hash = await batchHash(batch);
    hashes.push(hash);
    lastOn.set(branch, seq);
    return { batch, hash };
  }

  const commitTo = (branch: string, ops: Op[], hlc: string, base?: EntryRef) =>
    sign({ branch, ops, hlc, base });

  const commit = (ops: Op[], hlc: string, base?: EntryRef, undoes?: BatchRef) =>
    sign({ branch: "main", ops, hlc, base, undoes });

  return { peer, key, commit, commitTo };
}

/** A history of main sequenced by `sequencer`, and a helper that appends what it sequences. */
export function sequencedBy(sequencer: Awaited<ReturnType<typeof author>>) {
  const history = createHistory({ branch: "main", sequencer: sequencer.key });

  async function run() {
    const { entries: made } = await history.sequence(sequencer.peer);
    return made;
  }

  return { history, run };
}

export function fail(): never {
  throw new Error("missing");
}

export const rename = (name: string): Op => ({ op: "project.set", name });

export const sequenceAdd: Op = {
  op: "sequence.add",
  sequence: { name: "Main", rate: [24, 1], width: 1920, height: 1080, sampleRate: 48_000 },
};

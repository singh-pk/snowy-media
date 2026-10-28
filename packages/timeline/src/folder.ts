// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The project folder (docs/architecture.md#the-project-folder). A log or history is segments of
// records, each a 4-byte big-endian length then canonical bytes. A segment is named by its first
// seq or n and grows to SEGMENT_BYTES, since Chromium copies a whole file to append to it.

import { batchHash, decodeBatch, encodeBatch, verifyBatch, type Batch } from "./batch";
import { createBranches, type Changes } from "./branches";
import { entries as entryFormat } from "./entry";
import type { KeyId } from "./ids";
import { InvalidError } from "./schema";

/** Bytes for the editor to write into the file at `path`, from `offset`: the file's length so far. */
export type Write = { path: string; offset: number; bytes: Uint8Array };

export type FolderFile = { path: string; bytes: Uint8Array };

/** The size a log or history segment grows to before the next one starts. */
export const SEGMENT_BYTES = 1 << 20;

const LENGTH_BYTES = 4;

// A log's or history's last segment: its name, its length, and whether it ends in a record cut
// short, after which nothing written could be read.
type Tail = { first: number; size: number; cut: boolean };

function frame(bytes: Uint8Array) {
  const record = new Uint8Array(LENGTH_BYTES + bytes.byteLength);
  new DataView(record.buffer).setUint32(0, bytes.byteLength);
  record.set(bytes, LENGTH_BYTES);
  return record;
}

// The whole records of a segment, and whether the last one is cut short.
function records(bytes: Uint8Array) {
  const found: Uint8Array[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let at = 0; at < bytes.byteLength;) {
    const start = at + LENGTH_BYTES;
    if (start > bytes.byteLength) return { found, cut: true };
    const end = start + view.getUint32(at);
    if (end > bytes.byteLength) return { found, cut: true };
    found.push(bytes.subarray(start, end));
    at = end;
  }

  return { found, cut: false };
}

/**
 * What to write to the project folder for batches and entries: for a new project, or given the
 * last segment of each log and history and the hashes of the batches and entries written, as
 * `openFolder` finds them. It keeps and updates what it is given.
 */
export function createFolder(
  tails = new Map<string, Tail>(),
  written = { batches: new Set<string>(), entries: new Set<string>() },
) {
  function append(directory: string, number: number, bytes: Uint8Array): Write {
    const record = frame(bytes);
    let tail = tails.get(directory);
    const full =
      tail !== undefined && tail.size > 0 && tail.size + record.byteLength > SEGMENT_BYTES;

    // A new segment is never named as one before it, which a batch signed twice with one seq
    // would otherwise do.
    if (tail === undefined || tail.cut || full) {
      tail = { first: Math.max(number, (tail?.first ?? 0) + 1), size: 0, cut: false };
      tails.set(directory, tail);
    }

    const write = { path: `${directory}/${tail.first}`, offset: tail.size, bytes: record };
    tail.size += record.byteLength;
    return write;
  }

  return {
    /** What to write for a batch committed here or received, or nothing if it is written. */
    batch(batch: Batch, hash: string): Write | undefined {
      if (written.batches.has(hash)) return undefined;
      written.batches.add(hash);
      return append(`logs/${batch.author}`, batch.seq, encodeBatch(batch));
    },
    /** What to write for the entries a call applied, branch by branch, in order, each once. */
    changes(changes: Changes): Write[] {
      return [...changes].flatMap(([branch, change]) =>
        change.entered.flatMap(({ entry, hash }) => {
          if (written.entries.has(hash)) return [];
          written.entries.add(hash);
          return [append(`history/${branch}`, entry.n, entryFormat.encode(entry))];
        }),
      );
    },
  };
}

type Read<T> = { path: string; value: T };

// The objects of every segment under `kind`, with the tail of each directory. A file whose
// records don't all read is reported in `unreadable`, and the records that do are kept.
function readSegments<T>(
  files: readonly FolderFile[],
  kind: string,
  decode: (bytes: Uint8Array) => T,
  unreadable: string[],
) {
  const found: Array<Read<T>> = [];
  const tails = new Map<string, Tail>();

  for (const { path, bytes } of files) {
    const [top, directory, name, ...rest] = path.split("/");
    if (top !== kind || directory === undefined || rest.length > 0) continue;
    if (name === undefined || !/^[1-9][0-9]*$/.test(name)) continue;
    const first = Number(name);
    const { found: whole, cut } = records(bytes);
    const tail = tails.get(`${kind}/${directory}`);
    if (tail === undefined || tail.first < first)
      tails.set(`${kind}/${directory}`, { first, size: bytes.byteLength, cut });
    if (cut) unreadable.push(path);

    for (const record of whole) {
      try {
        found.push({ path, value: decode(record) });
      } catch (error) {
        if (!(error instanceof InvalidError)) throw error;
        unreadable.push(path);
      }
    }
  }

  return { found, tails };
}

const keyOf = (batch: { author: KeyId; seq: number }) => `${batch.author} ${batch.seq}`;

// The batches whose signature is their author's and that follow a batch of their author's
// before them, by hash, with each path holding one that doesn't. A batch after one that didn't
// read doesn't follow it either, so its file is reported too.
async function verified(read: Array<Read<Batch>>, unreadable: string[]) {
  const byHash = new Map<string, Batch>();
  const hashesOf = new Map<string, Set<string>>();
  const ordered = read.toSorted((a, b) => a.value.seq - b.value.seq);
  const checked = await Promise.all(
    ordered.map(async ({ path, value }) => {
      const [valid, hash] = await Promise.all([verifyBatch(value), batchHash(value)]);
      return { path, value, valid, hash };
    }),
  );

  for (const { path, value, valid, hash } of checked) {
    const chained =
      value.seq === 1 ||
      hashesOf.get(keyOf({ author: value.author, seq: value.seq - 1 }))?.has(value.prev) === true;

    if (!valid || !chained) {
      unreadable.push(path);
      continue;
    }

    byHash.set(hash, value);
    const same = hashesOf.get(keyOf(value)) ?? new Set<string>();
    same.add(hash);
    hashesOf.set(keyOf(value), same);
  }

  return byHash;
}

/**
 * Opens a project from the files of its folder: every author's log and every branch's history,
 * with `sequencer` sequencing main. Batches and entries are checked as they would be received;
 * the paths of files holding one that isn't valid are in `unreadable`, and the rest open. That
 * includes a file whose batches follow one that didn't read, and an entry refused as it is
 * applied; an entry that waits, for its batch or its branch, is checked when it can apply.
 * Returns the branches and what to write from then on.
 */
export async function openFolder(files: readonly FolderFile[], options: { sequencer: KeyId }) {
  const unreadable: string[] = [];
  const logs = readSegments(files, "logs", decodeBatch, unreadable);
  const histories = readSegments(files, "history", entryFormat.decode, unreadable);
  const batches = await verified(logs.found, unreadable);
  const branches = createBranches({ sequencer: options.sequencer });
  // Main first and each history in order, every batch just before its entry, so the entries
  // apply in the order shown and nothing is shown twice.
  const ordered = histories.found.toSorted(
    (a, b) =>
      Number(a.value.branch !== "main") - Number(b.value.branch !== "main") ||
      a.value.n - b.value.n,
  );
  const pended = new Set<string>();

  for (const { path, value: entry } of ordered) {
    const batch = batches.get(entry.batch.hash);

    if (batch !== undefined && !pended.has(entry.batch.hash)) {
      pended.add(entry.batch.hash);
      await branches.pend(batch, entry.batch.hash);
    }

    try {
      await branches.append(entry);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      unreadable.push(path);
    }
  }

  for (const [hash, batch] of batches) {
    if (!pended.has(hash)) await branches.pend(batch, hash);
  }

  const tails = new Map([...logs.tails, ...histories.tails]);
  // An entry that waits for its batch is written when it applies unless it is known as read.
  const entries = await Promise.all(histories.found.map(({ value }) => entryFormat.hash(value)));
  const folder = createFolder(tails, {
    batches: new Set(batches.keys()),
    entries: new Set(entries),
  });
  return { branches, folder, unreadable: [...new Set(unreadable)] };
}

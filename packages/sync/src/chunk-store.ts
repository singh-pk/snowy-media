// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Media chunks in the local store (docs/architecture.md#local-store): `media/<track>/<index>` in
// the session's OPFS directory, each holding the sealed bytes as they came, so a peer forwards
// them unchanged. A chunk is stored only once it checks out, and one whose key is stored, or
// being stored, is thrown away unread. Each file is written through a writable stream, which
// Chromium writes aside and moves into place on close, so a browser crash leaves a chunk whole or
// empty, never torn. The store owns `media/`: on opening, it removes whatever isn't a chunk, such
// as an empty file or a swap file a crash left, which would otherwise count against the quota.
// The store is this origin's own, so what reads back after a reload isn't checked again.

import { chunkKey, chunkSlot, openChunk, type ChunkSlot } from "./chunk";
import type { Bytes, SealedObject } from "./crypto";

export type ChunkStoreOptions = {
  /** The session's public key, which signs every chunk. */
  sessionKey: CryptoKey;
  /** The content key, which seals every chunk. */
  content: CryptoKey;
  /** Called with each chunk stored. What it throws is reported, as the chunk stays stored. */
  onStored?: (slot: ChunkSlot) => void;
  /** Called with each chunk evicted. What it throws is reported, as the chunk stays gone. */
  onEvicted?: (slot: ChunkSlot) => void;
};

const isError = (error: unknown, name: string) =>
  error instanceof DOMException && error.name === name;

// Tells a callback, reporting what it throws rather than rejecting: the store has changed either
// way.
function report(callback: ((slot: ChunkSlot) => void) | undefined, slot: ChunkSlot) {
  try {
    callback?.(slot);
  } catch (error) {
    reportError(error);
  }
}

// Whether an entry of a track's directory is a chunk: a file named as a chunk key spells it, with
// bytes in it.
async function isChunk(track: string, index: string, entry: FileSystemHandle) {
  if (!(entry instanceof FileSystemFileHandle)) return false;
  if (chunkSlot(`media/${track}/${index}`) === undefined) return false;
  const file = await entry.getFile();
  return file.size > 0;
}

// Every chunk a session's `media` directory holds, removing anything else once it has looked.
async function restore(media: FileSystemDirectoryHandle) {
  const slots: ChunkSlot[] = [];
  const strays: { dir: FileSystemDirectoryHandle; name: string }[] = [];

  for await (const [track, dir] of media.entries()) {
    if (
      !(dir instanceof FileSystemDirectoryHandle) ||
      chunkSlot(`media/${track}/0`) === undefined
    ) {
      strays.push({ dir: media, name: track });
      continue;
    }

    for await (const [index, entry] of dir.entries()) {
      const chunk = await isChunk(track, index, entry);
      if (chunk) slots.push({ track: Number(track), index: Number(index) });
      else strays.push({ dir, name: index });
    }
  }

  for (const { dir, name } of strays) await dir.removeEntry(name, { recursive: true });
  return slots;
}

// Removes a file a write left behind, if it can: one it can't is empty, which the next opening
// removes.
async function discard(
  dir: FileSystemDirectoryHandle,
  name: string,
  writable: FileSystemWritableFileStream,
) {
  try {
    await writable.abort();
  } catch {
    // Already errored, so nothing more is written.
  }

  try {
    await dir.removeEntry(name);
  } catch {
    // Left empty.
  }
}

/**
 * Opens the chunks in a session's OPFS directory, reading which are stored. Restoring reports
 * nothing through `onStored`.
 */
export async function openChunkStore(
  session: FileSystemDirectoryHandle,
  options: ChunkStoreOptions,
) {
  const media = await session.getDirectoryHandle("media", { create: true });
  // Each track's stored indexes.
  const held = new Map<number, Set<number>>();
  // Keys being stored or evicted, so a copy that arrives meanwhile is thrown away.
  const busy = new Set<string>();

  const has = ({ track, index }: ChunkSlot) => held.get(track)?.has(index) === true;

  function add({ track, index }: ChunkSlot) {
    const indexes = held.get(track) ?? new Set();
    indexes.add(index);
    held.set(track, indexes);
  }

  const restored = await restore(media);
  for (const slot of restored) add(slot);

  async function write({ track, index }: ChunkSlot, sealed: Bytes) {
    const dir = await media.getDirectoryHandle(String(track), { create: true });
    const file = await dir.getFileHandle(String(index), { create: true });
    const writable = await file.createWritable();

    try {
      await writable.write(sealed);
      await writable.close();
    } catch (error) {
      await discard(dir, String(index), writable);
      throw error;
    }
  }

  /**
   * Stores a sealed chunk once it checks out, and reports it through `onStored`. Resolves false,
   * unread, for one whose key is stored or being stored or evicted. Rejects, storing nothing,
   * with an `InvalidChunkError` for one that doesn't check out, or as the write does: a
   * `QuotaExceededError` when storage is full.
   */
  async function put(object: SealedObject) {
    const slot = chunkSlot(object.key);
    if (slot !== undefined && (has(slot) || busy.has(object.key))) return false;
    busy.add(object.key);

    try {
      const { track, index } = await openChunk(options.sessionKey, options.content, object);
      await write({ track, index }, object.sealed);
      add({ track, index });
      report(options.onStored, { track, index });
    } finally {
      busy.delete(object.key);
    }

    return true;
  }

  /** A stored chunk's sealed bytes, to forward unchanged, or undefined for one not stored. */
  async function get({ track, index }: ChunkSlot): Promise<Bytes | undefined> {
    if (!has({ track, index })) return undefined;

    try {
      const dir = await media.getDirectoryHandle(String(track));
      const handle = await dir.getFileHandle(String(index));
      const file = await handle.getFile();
      const buffer = await file.arrayBuffer();
      return new Uint8Array(buffer);
    } catch (error) {
      // Evicted while it was read: gone before `getFile`, or after, when the snapshot no longer
      // reads.
      if (isError(error, "NotFoundError") || isError(error, "NotReadableError")) return undefined;
      throw error;
    }
  }

  /**
   * Deletes a stored chunk and reports it through `onEvicted`. Resolves false for one not stored,
   * or still being stored; rejects, keeping the chunk, if it can't be deleted.
   */
  async function evict(slot: ChunkSlot) {
    const key = chunkKey(slot);
    if (!has(slot) || busy.has(key)) return false;
    busy.add(key);
    held.get(slot.track)?.delete(slot.index);

    try {
      const dir = await media.getDirectoryHandle(String(slot.track));
      await dir.removeEntry(String(slot.index));
    } catch (error) {
      // Already gone, such as when site data was cleared: evicted all the same, or `has` would
      // claim a chunk that no one fetches again.
      if (!isError(error, "NotFoundError")) {
        add(slot);
        throw error;
      }
    } finally {
      busy.delete(key);
    }

    report(options.onEvicted, slot);
    return true;
  }

  /** A track's stored indexes, in order. */
  // copy: a Set can't be sorted, so its indexes go into an array.
  const indexes = (track: number) => [...(held.get(track) ?? [])].toSorted((a, b) => a - b);

  return { put, get, has, evict, indexes };
}

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Media chunks in the local store (src/chunk-store.ts), in Chromium's OPFS: a chunk that checks
// out is stored as its sealed bytes came, reported, and read back after reopening; a copy of a
// chunk stored or being stored is thrown away; a chunk that doesn't check out stores nothing; an
// evicted chunk is reported and gone after reopening; and on reopening, a file that isn't a
// chunk's, or an empty one a crash left, is removed. A chunk being stored isn't evicted, and one
// being evicted isn't stored; one read while evicted reads whole or not at all; a failed write
// stores nothing and leaves no file; and a failed evict keeps the chunk.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { encodeChunk, InvalidChunkError, sealChunk, type ChunkSlot } from "../src/chunk";
import { openChunkStore } from "../src/chunk-store";
import { contentKey, generateKeyPair, keyId, seal, type Bytes } from "../src/crypto";
import { rejection } from "./support/rejection";

const session = await generateKeyPair();
const sessionId = await keyId(session.publicKey);
const content = await contentKey(crypto.getRandomValues(new Uint8Array(32)), sessionId);

// A chunk of one keyframe, two seconds long, in its slot.
const sealed = async (track: number, index: number) =>
  sealChunk(session, content, {
    track,
    index,
    startUs: index * 2_000_000,
    endUs: (index + 1) * 2_000_000,
    packets: [
      {
        ptsUs: index * 2_000_000,
        dtsUs: index * 2_000_000,
        durationUs: 2_000_000,
        keyframe: true,
        data: crypto.getRandomValues(new Uint8Array(64)),
      },
    ],
  });

const [v0, v1, v2, a0] = await Promise.all([
  sealed(0, 0),
  sealed(0, 1),
  sealed(0, 2),
  sealed(1, 0),
]);

// A session directory of its own: every test file shares the origin's OPFS.
async function directory() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(`session-${crypto.randomUUID()}`, { create: true });
}

// A store on a session's directory, with every chunk it reports kept.
async function open(dir: FileSystemDirectoryHandle) {
  const stored: ChunkSlot[] = [];
  const evicted: ChunkSlot[] = [];
  const store = await openChunkStore(dir, {
    sessionKey: session.publicKey,
    content,
    onStored: (slot) => stored.push(slot),
    onEvicted: (slot) => evicted.push(slot),
  });
  return { store, stored, evicted };
}

// The names in a track's directory, sorted.
async function files(dir: FileSystemDirectoryHandle, track: number) {
  const media = await dir.getDirectoryHandle("media");
  const trackDir = await media.getDirectoryHandle(String(track), { create: true });
  return listing(trackDir);
}

test("a chunk that checks out is stored as it came, reported, and read back after reopening", async () => {
  const dir = await directory();
  const { store, stored } = await open(dir);
  const kept = await Promise.all([store.put(v2), store.put(v0), store.put(a0)]);
  expect(kept).toEqual([true, true, true]);
  expect(stored.toSorted((a, b) => a.track - b.track || a.index - b.index)).toEqual([
    { track: 0, index: 0 },
    { track: 0, index: 2 },
    { track: 1, index: 0 },
  ]);
  expect(store.indexes(0)).toEqual([0, 2]);
  expect(store.has({ track: 0, index: 1 })).toBe(false);
  const read = await store.get({ track: 0, index: 2 });
  expect(read).toEqual(v2.sealed);
  const missing = await store.get({ track: 0, index: 1 });
  expect(missing).toBeUndefined();

  const reopened = await open(dir);
  expect(reopened.store.indexes(0)).toEqual([0, 2]);
  expect(reopened.store.indexes(1)).toEqual([0]);
  expect(reopened.stored).toEqual([]);
  const again = await reopened.store.get({ track: 1, index: 0 });
  expect(again).toEqual(a0.sealed);
});

test("a copy of a chunk stored or being stored is thrown away", async () => {
  const dir = await directory();
  const { store, stored } = await open(dir);
  const both = await Promise.all([store.put(v1), store.put(v1)]);
  expect(both.toSorted()).toEqual([false, true]);
  // Unread: even bytes that wouldn't open are thrown away, not refused.
  const late = await store.put({ key: v1.key, sealed: new Uint8Array(8) });
  expect(late).toBe(false);
  expect(stored).toEqual([{ track: 0, index: 1 }]);
});

test("a chunk that doesn't check out stores nothing", async () => {
  const dir = await directory();
  const { store, stored } = await open(dir);
  const forger = await generateKeyPair();
  const forged = await sealChunk(forger, content, {
    track: 0,
    index: 0,
    startUs: 0,
    endUs: 2_000_000,
    packets: [],
  });
  // Someone with the content key seals a chunk again under another slot's key.
  const bytes = await encodeChunk(session, {
    track: 0,
    index: 0,
    startUs: 0,
    endUs: 2_000_000,
    packets: [],
  });
  const resealed = await seal(content, "media/0/2", bytes);
  const errors = await Promise.all([
    rejection(store.put({ key: "media/0/1", sealed: v0.sealed })),
    rejection(store.put({ key: "media/0/2", sealed: resealed })),
    rejection(store.put(forged)),
    rejection(store.put({ key: "media/0/01", sealed: v1.sealed })),
    rejection(store.put({ key: "init/0", sealed: v0.sealed })),
  ]);
  expect(errors).toEqual([
    new InvalidChunkError("doesn't open"),
    new InvalidChunkError("another slot"),
    new InvalidChunkError("another session"),
    new InvalidChunkError("not a chunk key: media/0/01"),
    new InvalidChunkError("not a chunk key: init/0"),
  ]);
  expect(store.indexes(0)).toEqual([]);
  const names = await files(dir, 0);
  expect(names).toEqual([]);
  expect(stored).toEqual([]);
});

test("an evicted chunk is reported and gone after reopening", async () => {
  const dir = await directory();
  const { store, evicted } = await open(dir);
  await Promise.all([store.put(v0), store.put(v1)]);
  const results = await Promise.all([
    store.evict({ track: 0, index: 0 }),
    store.evict({ track: 0, index: 0 }),
    store.evict({ track: 0, index: 2 }),
  ]);
  expect(results).toEqual([true, false, false]);
  expect(evicted).toEqual([{ track: 0, index: 0 }]);
  const gone = await store.get({ track: 0, index: 0 });
  expect(gone).toBeUndefined();
  const names = await files(dir, 0);
  expect(names).toEqual(["1"]);

  const reopened = await open(dir);
  expect(reopened.store.indexes(0)).toEqual([1]);

  // Stored again once a peer sends it.
  const back = await reopened.store.put(v0);
  expect(back).toBe(true);
});

// Writes bytes to a file in a directory, creating it.
async function scribble(dir: FileSystemDirectoryHandle, name: string, bytes: Bytes) {
  const file = await dir.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  await writable.write(bytes);
  await writable.close();
}

// The names in a directory, sorted.
async function listing(dir: FileSystemDirectoryHandle) {
  const found = [];
  for await (const name of dir.keys()) found.push(name);
  return found.toSorted();
}

test("on reopening, whatever in media isn't a chunk is removed: other names, and empty files", async () => {
  const dir = await directory();
  const { store } = await open(dir);
  await store.put(v0);
  const media = await dir.getDirectoryHandle("media");
  const track = await media.getDirectoryHandle("0");
  const named = await media.getDirectoryHandle("video", { create: true });
  const bytes = new Uint8Array([1, 2, 3]);
  await Promise.all([
    scribble(track, "01", bytes),
    scribble(track, "notes", bytes),
    scribble(track, "1.crswap", bytes),
    track.getDirectoryHandle("2", { create: true }),
    track.getFileHandle("7", { create: true }),
    scribble(named, "1", bytes),
    scribble(media, "3", bytes),
  ]);

  const reopened = await open(dir);
  expect(reopened.store.indexes(0)).toEqual([0]);
  const left = await listing(media);
  const inTrack = await listing(track);
  expect(left).toEqual(["0"]);
  expect(inTrack).toEqual(["0"]);

  const seven = await sealed(0, 7);
  const kept = await reopened.store.put(seven);
  expect(kept).toBe(true);
  const read = await reopened.store.get({ track: 0, index: 7 });
  expect(read).toEqual(seven.sealed);
});

test("a chunk being stored isn't evicted, and one being evicted isn't stored", async () => {
  const dir = await directory();
  const { store, stored, evicted } = await open(dir);
  const putting = store.put(v0);
  const early = await store.evict({ track: 0, index: 0 });
  const put = await putting;
  expect([early, put]).toEqual([false, true]);

  const evicting = store.evict({ track: 0, index: 0 });
  const during = await store.put(v0);
  const gone = await evicting;
  expect([during, gone]).toEqual([false, true]);
  expect(store.has({ track: 0, index: 0 })).toBe(false);
  expect(stored).toEqual([{ track: 0, index: 0 }]);
  expect(evicted).toEqual([{ track: 0, index: 0 }]);
});

test("a chunk read while it is evicted reads whole or not at all", async () => {
  const dir = await directory();
  const { store } = await open(dir);
  await store.put(v1);
  const [read] = await Promise.all([
    store.get({ track: 0, index: 1 }),
    store.evict({ track: 0, index: 1 }),
  ]);
  expect(read === undefined || read.length === v1.sealed.length).toBe(true);
});

test("a chunk whose file was removed behind the store's back is evicted all the same", async () => {
  const dir = await directory();
  const { store, evicted } = await open(dir);
  await store.put(v2);
  const media = await dir.getDirectoryHandle("media");
  const track = await media.getDirectoryHandle("0");
  await track.removeEntry("2");
  const gone = await store.evict({ track: 0, index: 2 });
  expect(gone).toBe(true);
  expect(store.has({ track: 0, index: 2 })).toBe(false);
  expect(evicted).toEqual([{ track: 0, index: 2 }]);
});

test("a write that fails stores nothing, and the chunk can be stored later", async () => {
  const dir = await directory();
  const { store, stored } = await open(dir);
  // A file where the track's directory should be, so the write fails.
  const media = await dir.getDirectoryHandle("media");
  await scribble(media, "1", new Uint8Array([1]));
  const failed = await rejection(store.put(a0));
  expect(failed).toBeInstanceOf(DOMException);
  expect(store.has({ track: 1, index: 0 })).toBe(false);
  expect(stored).toEqual([]);

  await media.removeEntry("1");
  const kept = await store.put(a0);
  expect(kept).toBe(true);
});

// `handle`, with some of its methods replaced and the rest still its own.
function patched<T extends object>(handle: T, methods: object): T {
  return new Proxy(handle, {
    get(target, key) {
      if (key in methods) return Reflect.get(methods, key);
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const failing = (name: string) => Promise.reject(new DOMException("injected", name));

// A session directory whose chunk writes or removals fail while `faults` says so, as a full disk
// or a file held elsewhere would.
async function faulty() {
  const real = await directory();
  const media = await real.getDirectoryHandle("media", { create: true });
  const faults = { write: false, remove: false };

  const failingWrites = (file: FileSystemFileHandle) =>
    patched(file, {
      async createWritable() {
        const writable = await file.createWritable();
        if (!faults.write) return writable;
        return patched(writable, { write: () => failing("QuotaExceededError") });
      },
    });

  const track = (dir: FileSystemDirectoryHandle) =>
    patched(dir, {
      async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
        const file = await dir.getFileHandle(name, options);
        return failingWrites(file);
      },
      removeEntry: (name: string) =>
        faults.remove ? failing("NoModificationAllowedError") : dir.removeEntry(name),
    });

  const faultyMedia = patched(media, {
    async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
      const dir = await media.getDirectoryHandle(name, options);
      return track(dir);
    },
  });
  const wrapped = patched(real, { getDirectoryHandle: async () => faultyMedia });
  return { wrapped, real, faults };
}

test("a write that fails, as on a full disk, leaves no file behind", async () => {
  const { wrapped, real, faults } = await faulty();
  const { store, stored } = await open(wrapped);
  faults.write = true;
  const failed = await rejection(store.put(v0));
  expect(failed).toEqual(new DOMException("injected", "QuotaExceededError"));
  expect(store.has({ track: 0, index: 0 })).toBe(false);
  expect(stored).toEqual([]);
  const left = await files(real, 0);
  expect(left).toEqual([]);

  faults.write = false;
  const kept = await store.put(v0);
  expect(kept).toBe(true);
  const written = await files(real, 0);
  expect(written).toEqual(["0"]);
});

test("an evict that fails keeps the chunk", async () => {
  const { wrapped, real, faults } = await faulty();
  const { store, evicted } = await open(wrapped);
  await store.put(v0);
  faults.remove = true;
  const failed = await rejection(store.evict({ track: 0, index: 0 }));
  expect(failed).toEqual(new DOMException("injected", "NoModificationAllowedError"));
  expect(store.has({ track: 0, index: 0 })).toBe(true);
  expect(evicted).toEqual([]);
  const kept = await files(real, 0);
  expect(kept).toEqual(["0"]);
});

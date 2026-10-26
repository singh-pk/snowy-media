// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The project folder (src/folder.ts), in Chromium: what a project writes opens again as the same
// branches, entries, documents and pending batches; logs grow in segments; and a file that
// doesn't read is reported while the rest opens.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { createBranches, type Changes } from "../src/branches";
import { entries } from "../src/entry";
import { createFolder, openFolder, SEGMENT_BYTES, type Write } from "../src/folder";
import { author, fail, rename } from "./support/history";
import type { Op } from "./support/project";

// A folder in memory, which takes writes as the editor would: each at the file's end.
function createDisk() {
  const files = new Map<string, Uint8Array>();

  function write(each: Write | undefined) {
    if (each === undefined) return;
    const was = files.get(each.path) ?? new Uint8Array();
    expect(each.offset).toBe(was.byteLength);
    const grown = new Uint8Array(was.byteLength + each.bytes.byteLength);
    grown.set(was);
    grown.set(each.bytes, was.byteLength);
    files.set(each.path, grown);
  }

  const read = () => [...files].map(([path, bytes]) => ({ path, bytes }));
  return { files, write, read };
}

// A project of two authors sequenced by `a`, writing everything to a disk.
async function setUp() {
  const a = await author();
  const b = await author();
  const disk = createDisk();
  let branches = createBranches({ sequencer: a.key });
  let folder = createFolder();
  let clock = 0;

  const writeChanges = (changes: Changes) => {
    for (const each of folder.changes(changes)) disk.write(each);
  };

  // Commits a batch on `branch`, writes it, and runs both sequencers unless `pending`.
  async function edit(by: typeof a, branch: string, ops: Op[], pending = false) {
    clock += 1;
    const hlc = clock.toString(16).padStart(16, "0");
    const base = branches.history(branch)?.head() ?? fail();
    const { batch, hash } = await by.commitTo(branch, ops, hlc, base);
    disk.write(folder.batch(batch, hash));
    const pended = await branches.pend(batch, hash);
    writeChanges(pended);
    if (pending) return batch;
    const byA = await branches.sequence(a.peer);
    writeChanges(byA.changes);
    const byB = await branches.sequence(b.peer);
    writeChanges(byB.changes);
    return batch;
  }

  // Opens the project again from the disk, and carries on with what it opened.
  async function reopen() {
    const opened = await openFolder(disk.read(), { sequencer: a.key });
    ({ branches, folder } = opened);
    return opened;
  }

  return { a, b, disk, edit, reopen, branches: () => branches };
}

// What a peer reads of every branch.
const state = (branches: ReturnType<typeof createBranches>) =>
  branches.branches().map((branch) => {
    const history = branches.history(branch.id) ?? fail();
    return {
      branch,
      entries: history.entries(),
      pending: history.pending(),
      document: history.document().snapshot(),
    };
  });

test("a project opens from its folder as it was: branches, entries, documents and pending batches", async () => {
  const { a, b, edit, reopen, branches } = await setUp();
  await edit(a, "main", [rename("One")]);
  await edit(b, "main", [{ op: "branch.create", name: "Alt" }]);
  const alt = `${b.key}.1.0`;
  await edit(b, alt, [rename("Alt")]);
  await edit(a, "main", [
    { op: "branch.merge", branch: alt, through: branches().history(alt)?.head() ?? fail() },
  ]);
  await edit(b, "main", [rename("Pending")], true);
  const before = state(branches());

  const { unreadable } = await reopen();
  expect(unreadable).toEqual([]);
  expect(state(branches())).toEqual(before);

  // Writing carries on at the end of each log and history.
  await edit(a, "main", [rename("After")]);
  expect(branches().history("main")?.document().name()).toBe("After");
});

test("a log grows in segments, each named by its first seq", async () => {
  const { a, disk, edit, reopen, branches } = await setUp();
  const long = "x".repeat(256);
  const ops = Array.from({ length: 1500 }, () => rename(long));
  for (let i = 0; i < 3; i += 1) await edit(a, "main", ops);
  const segments = [...disk.files.keys()].filter((path) => path.startsWith("logs/")).toSorted();
  expect(segments).toEqual([`logs/${a.key}/1`, `logs/${a.key}/3`]);
  for (const path of segments) expect(disk.files.get(path)?.byteLength).toBeLessThan(SEGMENT_BYTES);

  await reopen();
  expect(branches().history("main")?.entries()).toHaveLength(3);
});

test("a file that doesn't read is reported, and the rest of the project opens", async () => {
  const { a, b, disk, edit, reopen, branches } = await setUp();
  await edit(a, "main", [rename("One")]);
  await edit(b, "main", [rename("Two")]);
  const path = `logs/${b.key}/1`;
  const bytes = disk.files.get(path) ?? fail();
  disk.files.set(path, bytes.subarray(0, bytes.byteLength - 1));

  const { unreadable } = await reopen();
  expect(unreadable).toEqual([path]);
  const main = branches().history("main") ?? fail();
  // B's entry waits for the batch it names.
  expect(main.entries()).toHaveLength(1);
  expect(main.document().name()).toBe("One");
});

test("a segment cut short keeps the records before the cut, and writing goes on in a new one", async () => {
  const { a, disk, edit, reopen, branches } = await setUp();
  await edit(a, "main", [rename("One")]);
  await edit(a, "main", [rename("Two")]);
  const path = "history/main/1";
  const bytes = disk.files.get(path) ?? fail();
  disk.files.set(path, bytes.subarray(0, bytes.byteLength - 1));

  const { unreadable } = await reopen();
  expect(unreadable).toEqual([path]);
  expect(branches().history("main")?.entries()).toHaveLength(1);

  // Entry 2 is lost, so the sequencer signs it again, here for the same batch, in a segment
  // after the cut one.
  await edit(a, "main", [rename("Three")]);
  expect(disk.files.has("history/main/2")).toBe(true);
  await reopen();
  const main = branches().history("main") ?? fail();
  expect(main.entries()).toHaveLength(3);
  expect(main.document().name()).toBe("Three");
});

test("the sequencer signs nothing while an entry it signed waits for its batch", async () => {
  const { a, b, disk, edit, reopen, branches } = await setUp();
  await edit(a, "main", [rename("One")]);
  await edit(a, "main", [rename("Two")]);
  const path = `logs/${a.key}/1`;
  const bytes = disk.files.get(path) ?? fail();
  disk.files.set(path, bytes.subarray(0, bytes.byteLength - 1));

  const { unreadable } = await reopen();
  expect(unreadable).toEqual([path]);
  await edit(b, "main", [rename("Three")]);
  const main = branches().history("main") ?? fail();
  expect(main.entries()).toHaveLength(1);
  expect(main.pending()).toHaveLength(1);
});

test("a new segment is never named as one before it", async () => {
  const a = await author();
  const tails = new Map([[`logs/${a.key}`, { first: 1, size: SEGMENT_BYTES, cut: false }]]);
  const folder = createFolder(tails);
  const { batch, hash } = await a.commit([rename("One")], "0000000000000001");
  const written = folder.batch(batch, hash) ?? fail();
  expect([written.path, written.offset]).toEqual([`logs/${a.key}/2`, 0]);
});

test("a batch is written once, however often it is handed over", async () => {
  const a = await author();
  const folder = createFolder();
  const { batch, hash } = await a.commit([rename("One")], "0000000000000001");
  expect(folder.batch(batch, hash)?.path).toBe(`logs/${a.key}/1`);
  expect(folder.batch(batch, hash)).toBe(undefined);
});

// A record as a segment holds it: its length, then its bytes.
function framed(bytes: Uint8Array) {
  const record = new Uint8Array(4 + bytes.byteLength);
  new DataView(record.buffer).setUint32(0, bytes.byteLength);
  record.set(bytes, 4);
  return record;
}

test("every kind of damage is reported by its file, and the rest of the project opens", async () => {
  const { a, b, disk, edit, reopen, branches } = await setUp();
  await edit(a, "main", [rename("One")]);
  await edit(b, "main", [rename("Two")]);

  const grow = (path: string, more: Uint8Array) => {
    const was = disk.files.get(path) ?? fail();
    const grown = new Uint8Array(was.byteLength + more.byteLength);
    grown.set(was);
    grown.set(more, was.byteLength);
    disk.files.set(path, grown);
  };

  // Two bytes, too few for a record's length.
  grow(`logs/${a.key}/1`, new Uint8Array(2));
  // A whole record that isn't a batch.
  grow(`logs/${b.key}/1`, framed(new Uint8Array([0xff])));
  // A file that isn't a segment.
  disk.files.set(`logs/${b.key}/notes`, new Uint8Array([1]));
  // A batch whose author's batch before it is missing.
  const c = await author();
  await c.commit([rename("Lost")], "0000000000000001");
  const unchained = await c.commit([rename("Three")], "0000000000000002");
  const written = createFolder().batch(unchained.batch, unchained.hash) ?? fail();
  disk.files.set(written.path, written.bytes);
  // An entry not signed by the sequencer.
  const head = branches().history("main")?.head() ?? fail();
  const forged = await entries.sign(b.peer.privateKey, {
    branch: "main",
    n: head.n + 1,
    term: 1,
    prev: head.hash,
    batch: { author: c.key, seq: 2, hash: unchained.hash },
  });
  disk.files.set(`history/main/${head.n + 1}`, framed(entries.encode(forged)));

  const { unreadable } = await reopen();
  expect(unreadable.toSorted()).toEqual(
    [
      `history/main/${head.n + 1}`,
      `logs/${a.key}/1`,
      `logs/${b.key}/1`,
      `logs/${c.key}/2`,
    ].toSorted(),
  );
  const main = branches().history("main") ?? fail();
  expect(main.entries()).toHaveLength(2);
  expect(main.document().name()).toBe("Two");
});

test("an entry is written once, however often it is handed over", async () => {
  const a = await author();
  const branches = createBranches({ sequencer: a.key });
  const folder = createFolder();
  const { batch, hash } = await a.commit([rename("One")], "0000000000000001");
  await branches.pend(batch, hash);
  const { changes } = await branches.sequence(a.peer);
  expect(folder.changes(changes).map(({ path }) => path)).toEqual(["history/main/1"]);
  expect(folder.changes(changes)).toEqual([]);
});

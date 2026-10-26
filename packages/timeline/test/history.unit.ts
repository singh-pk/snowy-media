// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// One branch's history (src/history.ts), in Chromium: pending batches show at once in (hlc,
// author) order, the sequencer's entries settle them, an entry that orders them otherwise
// rebuilds the shown document, and entries whose author couldn't see a change are marked.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { batchHash, keyIdOf, signBatch } from "../src/batch";
import { entries, refusals, type Entry } from "../src/entry";
import { createHistory } from "../src/history";
import { createProject } from "../src/project";
import { InvalidError } from "../src/schema";
import { asset, clip, id, sequence, setUp, video, type Op } from "./support/project";
import {
  author,
  fail,
  generate,
  pendEach,
  rename,
  sequenceAdd,
  sequencedBy,
} from "./support/history";
import { rejection } from "./support/rejection";

test("an entry and a refusal sign, verify and read back from their bytes", async () => {
  const sequencer = await generate();
  const key = await keyIdOf(sequencer.publicKey);
  const batch = { author: key, seq: 1, hash: "A".repeat(43) };
  const entry = await entries.sign(sequencer.privateKey, {
    branch: "main",
    n: 1,
    term: 1,
    prev: "",
    batch,
  });
  const valid = await entries.verify(entry, key);
  const moved = await entries.verify({ ...entry, n: 2, prev: "Q".repeat(43) }, key);
  expect(valid).toBe(true);
  expect(moved).toBe(false);
  expect(entries.decode(entries.encode(entry))).toEqual(entry);
  expect(() => entries.check({ ...entry, n: 2 })).toThrow(InvalidError);
  expect(() => entries.check({ ...entry, prev: "Q".repeat(43) })).toThrow(InvalidError);

  const refusal = await refusals.sign(sequencer.privateKey, {
    branch: "main",
    batch,
    reason: "rights",
    term: 1,
  });
  const refused = await refusals.verify(refusal, key);
  const changed = await refusals.verify({ ...refusal, reason: "chain" }, key);
  expect(refused).toBe(true);
  expect(changed).toBe(false);
  expect(refusals.decode(refusals.encode(refusal))).toEqual(refusal);
});

test("a project started from a snapshot reads and applies as the original", () => {
  const { project, apply } = setUp();
  const first = id(2, 0);
  apply(clip({ duration: 48 * 705_600_000 }));
  apply(clip({ anchor: { storyline: sequence, position: "a1" } }), {
    op: "item.add",
    item: { kind: "marker", anchor: { clip: first, at: 0 }, duration: 0, type: "todo", name: "x" },
  });
  apply({ op: "item.remove", id: id(3, 0) });
  apply({
    op: "keyframe.set",
    keyframe: {
      target: first,
      param: "video.opacity",
      at: 0,
      value: 0.5,
      ease: "linear",
    },
  });
  const copy = createProject(project.snapshot());
  expect(copy.snapshot()).toEqual(project.snapshot());
  expect(copy.storyline(sequence)).toEqual(project.storyline(sequence));
  expect(copy.item(id(3, 0))?.removed).toBe(true);

  const ops: Op[] = [
    { op: "clip.split", id: first, at: 705_600_000 },
    { op: "item.restore", id: id(3, 0) },
    // Both in use, as the copy's indexes must know.
    { op: "role.remove", id: video },
    { op: "asset.remove", id: asset },
  ];
  const original = project.apply({ author: "E".repeat(43), seq: 1, ops });
  const copied = copy.apply({ author: "E".repeat(43), seq: 1, ops });
  expect(original.skipped.map(({ index, reason }) => [index, reason])).toEqual([
    [2, "structural"],
    [3, "structural"],
  ]);
  expect(copied).toEqual(original);
  expect(copy.snapshot()).toEqual(project.snapshot());
});

const hashOf = (entry: Entry | undefined) => entries.hash(entry ?? fail());

test("a batch shows at once, and its entry changes nothing shown", async () => {
  const sequencer = await author();
  const { history } = sequencedBy(sequencer);
  const { batch, hash } = await sequencer.commit([rename("Cut")], "0000000000010000");
  const pended = await history.pend(batch, hash);
  expect(history.document().name()).toBe("Cut");
  expect(history.pending()).toEqual([batch]);
  expect(pended.entered).toEqual([]);

  const { entries: made, change } = await history.sequence(sequencer.peer);
  expect(made.map((entry) => entry.batch)).toEqual([{ author: sequencer.key, seq: 1, hash }]);
  expect(made[0]?.prev).toBe("");
  expect(change.ranges.size).toBe(0);
  expect(change.entered.map(({ concurrent, skipped }) => ({ concurrent, skipped }))).toEqual([
    { concurrent: false, skipped: [] },
  ]);
  expect(history.pending()).toEqual([]);
  expect(history.document().name()).toBe("Cut");
  const entryHash = await hashOf(made[0]);
  expect(history.head()).toEqual({ n: 1, hash: entryHash });
});

test("pending batches show in (hlc, author) order, and an entry ordering them otherwise reshows them", async () => {
  const a = await author();
  const b = await author();
  const sequencer = sequencedBy(a);
  const observer = createHistory({ branch: "main", sequencer: a.key });
  const first = await a.commit([sequenceAdd], "0000000000010000");
  await sequencer.history.pend(first.batch, first.hash);
  const [one] = await sequencer.run();
  await observer.pend(first.batch, first.hash);
  await observer.append(one ?? fail());

  const gap: Op = {
    op: "item.add",
    item: { kind: "gap", anchor: { storyline: `${a.key}.1.0`, position: "a0" }, duration: 1000 },
  };
  const later = await a.commit([rename("a"), gap], "0000000000030000", observer.head());
  const earlier = await b.commit([rename("b")], "0000000000020000", observer.head());
  await observer.pend(later.batch, later.hash);
  await observer.pend(earlier.batch, earlier.hash);
  expect(observer.pending()).toEqual([earlier.batch, later.batch]);
  expect(observer.document().name()).toBe("a");

  // The sequencer gets the later batch first, so appends it first.
  await sequencer.history.pend(later.batch, later.hash);
  const [two] = await sequencer.run();
  await sequencer.history.pend(earlier.batch, earlier.hash);
  const [three] = await sequencer.run();

  const reordered = await observer.append(two ?? fail());
  expect(observer.document().name()).toBe("b");
  expect(reordered.ranges.get(`${a.key}.1.0`)).toEqual({ from: 0, to: Number.POSITIVE_INFINITY });
  expect(observer.pending()).toEqual([earlier.batch]);

  const settled = await observer.append(three ?? fail());
  expect(settled.ranges.size).toBe(0);
  expect(observer.document().name()).toBe("b");
  expect(observer.document().snapshot()).toEqual(sequencer.history.document().snapshot());
});

test("an entry waits for its batch and for the entries before it", async () => {
  const a = await author();
  const sequencer = sequencedBy(a);
  const observer = createHistory({ branch: "main", sequencer: a.key });
  const first = await a.commit([rename("one")], "0000000000010000");
  const second = await a.commit([rename("two")], "0000000000020000");
  await sequencer.history.pend(first.batch, first.hash);
  await sequencer.history.pend(second.batch, second.hash);
  const made = await sequencer.run();
  expect(made.map((entry) => entry.n)).toEqual([1, 2]);

  const early = await observer.append(made[1] ?? fail());
  expect(early.entered).toEqual([]);
  const waiting = await observer.append(made[0] ?? fail());
  expect(waiting.entered).toEqual([]);
  await observer.pend(second.batch, second.hash);
  expect(observer.head().n).toBe(0);

  const caught = await observer.pend(first.batch, first.hash);
  expect(caught.entered.map(({ entry }) => entry.n)).toEqual([1, 2]);
  expect(observer.head()).toEqual(sequencer.history.head());
  expect(observer.document().name()).toBe("two");
});

test("an entry not signed by the sequencer, not following the last, or unlike the one appended is refused", async () => {
  const a = await author();
  const b = await author();
  const history = createHistory({ branch: "main", sequencer: a.key });
  const { batch, hash } = await a.commit([rename("x")], "0000000000010000");
  await history.pend(batch, hash);
  const ref = { author: a.key, seq: 1, hash };
  const forged = await entries.sign(b.peer.privateKey, {
    branch: "main",
    n: 1,
    term: 1,
    prev: "",
    batch: ref,
  });
  const forgedError = await rejection(history.append(forged));
  expect(forgedError).toBeInstanceOf(RangeError);

  const real = { branch: "main", n: 1, term: 1, prev: "", batch: ref } as const;
  const entry = await entries.sign(a.peer.privateKey, real);
  await history.append(entry);
  const second = await a.commit([rename("y")], "0000000000020000");
  await history.pend(second.batch, second.hash);
  const unchained = await entries.sign(a.peer.privateKey, {
    ...real,
    n: 2,
    prev: "Q".repeat(43),
    batch: { author: a.key, seq: 2, hash: second.hash },
  });
  const another = await entries.sign(a.peer.privateKey, {
    ...real,
    batch: { ...ref, hash: "Q".repeat(43) },
  });
  const unchainedError = await rejection(history.append(unchained));
  const anotherError = await rejection(history.append(another));
  const notSequencer = await rejection(history.sequence(b.peer));
  expect(unchainedError).toBeInstanceOf(RangeError);
  expect(anotherError).toBeInstanceOf(RangeError);
  expect(notSequencer).toBeInstanceOf(RangeError);
  expect(history.head().n).toBe(1);
  expect(history.document().name()).toBe("y");
});

test("the sequencer appends a batch only after its author's previous one on the branch", async () => {
  const a = await author();
  const { history, run } = sequencedBy(a);
  const first = await a.commit([rename("one")], "0000000000010000");
  const second = await a.commit([rename("two")], "0000000000020000");
  await history.pend(second.batch, second.hash);
  const held = await run();
  expect(held).toEqual([]);
  await history.pend(first.batch, first.hash);
  const made = await run();
  expect(made.map((entry) => entry.batch.seq)).toEqual([1, 2]);
  const firstHash = await hashOf(made[0]);
  const again = await run();
  expect(made[1]?.prev).toBe(firstHash);
  expect(again).toEqual([]);
});

test("an entry whose author couldn't see another's change to the same leaf is concurrent", async () => {
  const a = await author();
  const b = await author();
  const { history, run } = sequencedBy(a);
  const start = await a.commit([sequenceAdd], "0000000000010000");
  await history.pend(start.batch, start.hash);
  await run();
  const base = history.head();
  const set = (path: string, value: string | number): Op => ({
    op: "sequence.set",
    id: `${a.key}.1.0`,
    path,
    value,
  });
  const commits: Array<[typeof a, Op, string]> = [
    [a, set("name", "A"), "0000000000020000"],
    [b, set("width", 1280), "0000000000030000"],
    [a, set("name", "A2"), "0000000000040000"],
    [b, set("name", "B"), "0000000000050000"],
  ];

  await pendEach(history, commits, base);

  const { change } = await history.sequence(a.peer);
  expect(change.entered.map(({ concurrent }) => concurrent)).toEqual([false, false, false, true]);

  const after = await b.commit([set("name", "C")], "0000000000060000", history.head());
  await history.pend(after.batch, after.hash);
  const { change: next } = await history.sequence(a.peer);
  expect(next.entered.map(({ concurrent }) => concurrent)).toEqual([false]);
  expect(history.document().sequence(`${a.key}.1.0`)?.name).toBe("C");
});

test("an entry delivered twice at once is applied once", async () => {
  const a = await author();
  const { history, run } = sequencedBy(a);
  const observer = createHistory({ branch: "main", sequencer: a.key });
  const first = await a.commit([rename("one")], "0000000000010000");
  await history.pend(first.batch, first.hash);
  const made = await run();
  await observer.pend(first.batch, first.hash);
  const entry = made[0] ?? fail();
  await Promise.all([observer.append(entry), observer.append(entry)]);
  expect(observer.entries()).toEqual([entry]);
  const entryHash = await hashOf(entry);
  expect(observer.head()).toEqual({ n: 1, hash: entryHash });
});

test("of two batches an author signed with one seq, the entry picks which is applied", async () => {
  const a = await author();
  const b = await author();
  const { history } = sequencedBy(a);
  const observer = createHistory({ branch: "main", sequencer: a.key });
  const real = await b.commit([rename("real")], "0000000000010000");
  const { sig: _, ...unsigned } = real.batch;
  const other = await signBatch(b.peer, { ...unsigned, ops: [rename("other")] });
  const otherHash = await batchHash(other);
  await observer.pend(other, otherHash);
  await observer.pend(real.batch, real.hash);
  expect(observer.pending().length).toBe(2);

  await history.pend(real.batch, real.hash);
  const { entries: made } = await history.sequence(a.peer);
  const change = await observer.append(made[0] ?? fail());
  expect(change.entered.length).toBe(1);
  expect(observer.pending()).toEqual([]);
  expect(observer.document().name()).toBe("real");
  const late = await observer.pend(other, otherHash);
  expect(late.changed).toEqual([]);
  expect(observer.pending()).toEqual([]);
});

test("an entry naming a batch other than the one held waits for it", async () => {
  const a = await author();
  const b = await author();
  const { history, run } = sequencedBy(a);
  const observer = createHistory({ branch: "main", sequencer: a.key });
  const real = await b.commit([rename("real")], "0000000000010000");
  const { sig: _, ...unsigned } = real.batch;
  const other = await signBatch(b.peer, { ...unsigned, ops: [rename("other")] });
  const otherHash = await batchHash(other);
  await observer.pend(other, otherHash);
  await history.pend(real.batch, real.hash);
  const made = await run();

  const early = await observer.append(made[0] ?? fail());
  expect(early.entered).toEqual([]);
  expect(observer.document().name()).toBe("other");
  const caught = await observer.pend(real.batch, real.hash);
  expect(caught.entered.length).toBe(1);
  expect(observer.pending()).toEqual([]);
  expect(observer.document().name()).toBe("real");
});

// Sets a leaf of a sequence.
const setLeaf = (target: string, path: string, value: string | number): Op => ({
  op: "sequence.set",
  id: target,
  path,
  value,
});

test("removing an item clashes with any leaf of it, and a skipped operation touches nothing", async () => {
  const a = await author();
  const b = await author();
  const { history } = sequencedBy(a);
  const start = await a.commit([sequenceAdd, sequenceAdd], "0000000000010000");
  await history.pend(start.batch, start.hash);
  await history.sequence(a.peer);
  const base = history.head();
  const [kept, gone] = [`${a.key}.1.0`, `${a.key}.1.1`];
  const commits: Array<[typeof a, Op[], string]> = [
    [a, [setLeaf(kept, "name", "A"), setLeaf(gone, "name", "A")], "0000000000020000"],
    // A name that isn't a string is skipped, so touches nothing.
    [b, [setLeaf(kept, "name", 5)], "0000000000030000"],
    [b, [setLeaf(kept, "height", 720)], "0000000000040000"],
    [b, [{ op: "sequence.remove", id: gone }], "0000000000050000"],
  ];

  for (const [by, ops, hlc] of commits) {
    const { batch, hash } = await by.commit(ops, hlc, base);
    await history.pend(batch, hash);
  }

  const { change } = await history.sequence(a.peer);
  expect(change.entered.map(({ concurrent }) => concurrent)).toEqual([false, false, false, true]);
  expect(change.entered[1]?.skipped.length).toBe(1);
});

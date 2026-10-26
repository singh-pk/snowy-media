// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// One branch's history at its edges (src/history.ts), in Chromium: what it refuses from another
// branch or term, an early entry that turns out not to follow, one author's batches signed with
// one clock, a merge with nothing to find it, and undo for batches and authors it doesn't have.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { entries } from "../src/entry";
import { createHistory } from "../src/history";
import { author, fail, pendEach, rename, sequenceAdd, sequencedBy } from "./support/history";
import { clip, type Op } from "./support/project";
import { rejection } from "./support/rejection";

const CLOCK = "0000000000010000";

test("a batch or an entry of another branch, or an entry of a later term, is refused", async () => {
  const a = await author();
  const history = createHistory({ branch: "main", sequencer: a.key });
  const other = await a.commitTo(`${a.key}.9.0`, [rename("x")], CLOCK);
  const otherError = await rejection(history.pend(other.batch, other.hash));
  expect(otherError).toBeInstanceOf(RangeError);

  const { batch, hash } = await a.commit([rename("y")], CLOCK);
  await history.pend(batch, hash);
  const entry = { branch: "main", n: 1, term: 1, prev: "", batch: { author: a.key, seq: 2, hash } };
  const ofAlt = await entries.sign(a.peer.privateKey, { ...entry, branch: `${a.key}.9.0` });
  const ofTerm = await entries.sign(a.peer.privateKey, { ...entry, term: 2 });
  const altError = await rejection(history.append(ofAlt));
  const termError = await rejection(history.append(ofTerm));
  expect(altError).toBeInstanceOf(RangeError);
  expect(termError).toBeInstanceOf(RangeError);
  expect(history.head().n).toBe(0);
});

test("an early entry that turns out not to follow is dropped, and the real one taken", async () => {
  const a = await author();
  const sequencer = sequencedBy(a);
  const observer = createHistory({ branch: "main", sequencer: a.key });
  const first = await a.commit([rename("one")], CLOCK);
  const second = await a.commit([rename("two")], "0000000000020000");

  for (const { batch, hash } of [first, second]) {
    await sequencer.history.pend(batch, hash);
    await observer.pend(batch, hash);
  }

  const made = await sequencer.run();
  const real = made[1] ?? fail();
  const { sig: _, ...unsigned } = real;
  const unchained = await entries.sign(a.peer.privateKey, { ...unsigned, prev: "Q".repeat(43) });
  await observer.append(unchained);
  const entered = await observer.append(made[0] ?? fail());
  expect(entered.entered.map(({ entry }) => entry.n)).toEqual([1]);
  expect(observer.head().n).toBe(1);

  await observer.append(real);
  expect(observer.head()).toEqual(sequencer.history.head());
  expect(observer.document().name()).toBe("two");
});

test("one author's batches signed with one clock show in seq order, whatever order they come in", async () => {
  const a = await author();
  const history = createHistory({ branch: "main", sequencer: a.key });
  const first = await a.commit([rename("one")], CLOCK);
  const second = await a.commit([rename("two")], CLOCK);
  await history.pend(second.batch, second.hash);
  await history.pend(first.batch, first.hash);
  expect(history.pending().map(({ seq }) => seq)).toEqual([1, 2]);
  expect(history.document().name()).toBe("two");
});

test("without a way to find what a merge brings, a merge is stale", async () => {
  const a = await author();
  const { history } = sequencedBy(a);
  const merge = await a.commit(
    [{ op: "branch.merge", branch: `${a.key}.9.0`, through: { n: 1, hash: "Q".repeat(43) } }],
    CLOCK,
  );
  await history.pend(merge.batch, merge.hash);
  const { change } = await history.sequence(a.peer);
  expect(change.entered.map(({ skipped }) => skipped.map(({ reason }) => reason))).toEqual([
    ["stale"],
  ]);
});

test("undo finds nothing for an author with no batches, and refuses a batch it doesn't have", async () => {
  const a = await author();
  const b = await author();
  const history = createHistory({ branch: "main", sequencer: a.key });
  expect(history.undoable(b.key)).toBeUndefined();
  expect(history.redoable(b.key)).toBeUndefined();
  expect(() => history.undo({ author: b.key, seq: 1 })).toThrow(RangeError);
});

test("undoing a pending batch after another pending one sees the document the first left", async () => {
  const a = await author();
  const history = createHistory({ branch: "main", sequencer: a.key });
  const first = await a.commit([rename("one")], CLOCK);
  const second = await a.commit([rename("two")], "0000000000020000");
  await history.pend(first.batch, first.hash);
  await history.pend(second.batch, second.hash);
  expect(history.undo({ author: a.key, seq: 2 }).ops).toEqual([{ op: "project.set", name: "one" }]);
});

test("moving an item clashes with an unseen leaf of it, and a revert with any change unseen on either side", async () => {
  const a = await author();
  const b = await author();
  const { history } = sequencedBy(a);
  const clipId = `${a.key}.1.3`;
  const start = await a.commit(
    [
      sequenceAdd,
      {
        op: "role.add",
        role: { sequence: `${a.key}.1.0`, name: "V", kind: "video", color: "#000000", order: "a0" },
      },
      {
        op: "asset.add",
        asset: {
          id: "Q".repeat(43),
          size: 10,
          head: "E".repeat(43),
          tail: "I".repeat(43),
          name: "a.mp4",
          streams: [{ index: 0, kind: "video", timeBase: [1, 24], start: 0, duration: 48 }],
        },
      },
      clip({
        source: { asset: "Q".repeat(43), stream: 0 },
        role: `${a.key}.1.1`,
        anchor: { storyline: `${a.key}.1.0`, position: "a0" },
      }),
    ],
    CLOCK,
  );
  await history.pend(start.batch, start.hash);
  await history.sequence(a.peer);
  const base = history.head();
  const commits: Array<[typeof a, Op, string]> = [
    [
      a,
      { op: "item.move", id: clipId, anchor: { storyline: `${a.key}.1.0`, position: "a5" } },
      "0000000000020000",
    ],
    [b, { op: "item.set", id: clipId, path: "enabled", value: false }, "0000000000030000"],
    [b, { op: "revert", to: base }, "0000000000040000"],
    [a, { op: "item.set", id: clipId, path: "video.opacity", value: 0.5 }, "0000000000050000"],
  ];

  await pendEach(history, commits, base);

  const { change } = await history.sequence(a.peer);
  expect(change.entered.map(({ skipped }) => skipped)).toEqual([[], [], [], []]);
  expect(change.entered.map(({ concurrent }) => concurrent)).toEqual([false, true, true, true]);
});

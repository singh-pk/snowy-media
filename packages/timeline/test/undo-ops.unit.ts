// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// What takes back each kind of operation (src/undo.ts), in Chromium, on projects just before a
// batch, just after it and now: the operation that undoes it while it stands as the batch left it,
// and the reason it is left alone once something changed it since.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { createProject } from "../src/project";
import { undoBatch } from "../src/undo";
import {
  asset,
  audio,
  author,
  clip,
  id,
  innerSequence,
  type Op,
  SECOND,
  sequence,
  setUp,
  video,
} from "./support/project";

const other = "R".repeat(43);

const assetAdd = (assetId: string): Op => ({
  op: "asset.add",
  asset: {
    id: assetId,
    size: 10,
    head: "E".repeat(43),
    tail: "I".repeat(43),
    name: "b.mp4",
    streams: [{ index: 0, kind: "audio", timeBase: [1, 48_000], start: 0, duration: 48_000 }],
  },
});

const effect = (clipId: string): Op => ({
  op: "effect.add",
  effect: { clip: clipId, kind: "color.wheels", position: "a0", enabled: true, params: {} },
});

const opacity = (target: string, value: number): Op => ({
  op: "keyframe.set",
  keyframe: { target, param: "video.opacity", at: 0, value, ease: "linear" },
});

const move = (to: string): Op => ({
  op: "item.move",
  id: id(2, 0),
  anchor: { storyline: sequence, position: to },
});

const sequenceAdd: Op = {
  op: "sequence.add",
  sequence: { name: "Second", rate: [25, 1], width: 1280, height: 720, sampleRate: 48_000 },
};

/**
 * Undoes `ops`, applied as seq 3 after `prior` (seq 2), against the project before and after
 * them and the project now, after `since` (seq 4). The batch's skipped operations are left out.
 */
function undoOf(ops: Op[], { prior = [], since = [] }: { prior?: Op[]; since?: Op[] } = {}) {
  const { project, apply } = setUp();
  apply(...prior);
  const before = createProject(project.snapshot());
  const { seq, skipped } = apply(...ops);
  const after = createProject(project.snapshot());
  apply(...since);
  const left = new Set(skipped.map(({ index }) => index));
  return undoBatch({ author, seq, ops }, left, { before, after, now: project });
}

const reasons = (undo: ReturnType<typeof undoOf>) => undo.left.map(({ reason }) => reason);

test("an undo removes the sequence, role, effect and asset a batch added, past what it skipped", () => {
  const undo = undoOf(
    [...innerSequence(3), effect(id(2, 0)), assetAdd(other), { op: "item.remove", id: id(9, 9) }],
    { prior: [clip()] },
  );
  expect(undo.ops).toEqual([
    { op: "asset.remove", id: other },
    { op: "effect.remove", id: id(3, 2) },
    { op: "role.remove", id: id(3, 1) },
    { op: "sequence.remove", id: id(3, 0) },
  ]);
  expect(undo.left).toEqual([]);
});

test("an undo leaves alone a sequence, role, effect or asset changed since it was added", () => {
  const undo = undoOf([...innerSequence(3), effect(id(2, 0)), assetAdd(other)], {
    prior: [clip()],
    since: [
      { op: "sequence.set", id: id(3, 0), path: "name", value: "Renamed" },
      { op: "role.set", id: id(3, 1), path: "name", value: "W" },
      { op: "effect.set", id: id(3, 2), path: "enabled", value: false },
      { op: "asset.remove", id: other },
    ],
  });
  expect(undo.ops).toEqual([]);
  expect(reasons(undo)).toEqual(Array.from({ length: 4 }, () => "changed since"));
});

test("an undo adds back an asset the batch removed, unless it was added again since", () => {
  const undone = undoOf([{ op: "asset.remove", id: asset }]);
  expect(undone.ops.map((op) => op.op)).toEqual(["asset.add"]);
  const [added] = undone.ops;
  expect(added?.op === "asset.add" ? added.asset.name : undefined).toBe("a.mp4");

  const readded = undoOf([{ op: "asset.remove", id: other }], {
    prior: [assetAdd(other)],
    since: [assetAdd(other)],
  });
  expect(reasons(readded)).toEqual(["changed since"]);
});

test("an undo sets a sequence's, role's and effect's leaves back", () => {
  const undo = undoOf(
    [
      { op: "sequence.set", id: sequence, path: "name", value: "B" },
      { op: "role.set", id: video, path: "name", value: "Picture" },
      { op: "effect.set", id: id(2, 1), path: "enabled", value: false },
    ],
    { prior: [clip(), effect(id(2, 0))] },
  );
  expect(undo.ops).toEqual([
    { op: "effect.set", id: id(2, 1), path: "enabled", value: true },
    { op: "role.set", id: video, path: "name", value: "Video" },
    { op: "sequence.set", id: sequence, path: "name", value: "Main" },
  ]);
});

test("an undo of a leaf set leaves it alone when the record was added by the batch, removed since or had no value", () => {
  const added = undoOf([clip(), { op: "item.set", id: id(3, 0), path: "enabled", value: false }]);
  expect(added.ops).toEqual([{ op: "item.remove", id: id(3, 0) }]);
  expect(added.left).toEqual([]);

  const removed = undoOf([{ op: "item.set", id: id(2, 0), path: "enabled", value: false }], {
    prior: [clip()],
    since: [{ op: "item.remove", id: id(2, 0) }],
  });
  expect(reasons(removed)).toEqual(["removed since"]);

  const named = undoOf([{ op: "item.set", id: id(2, 0), path: "name", value: "A" }], {
    prior: [clip()],
  });
  expect(reasons(named)).toEqual(["had no value before"]);
});

test("an undo of a move leaves a clip the batch added to its removal, and one moved or removed since alone", () => {
  const added = undoOf([
    clip({ anchor: { storyline: sequence, position: "a1" } }),
    { op: "item.move", id: id(3, 0), anchor: { storyline: sequence, position: "a2" } },
  ]);
  expect(added.ops).toEqual([{ op: "item.remove", id: id(3, 0) }]);

  const removed = undoOf([move("a5")], {
    prior: [clip()],
    since: [{ op: "item.remove", id: id(2, 0) }],
  });
  expect(reasons(removed)).toEqual(["removed since"]);
  const moved = undoOf([move("a5")], { prior: [clip()], since: [move("a7")] });
  expect(reasons(moved)).toEqual(["changed since"]);
});

test("an undo removes a keyframe the batch set new, and sets back one it removed unless set since", () => {
  const remove = {
    op: "keyframe.remove" as const,
    target: id(2, 0),
    param: "video.opacity",
    at: 0,
  };
  const set = undoOf([opacity(id(2, 0), 0.5)], { prior: [clip()] });
  expect(set.ops).toEqual([remove]);
  const setSince = undoOf([opacity(id(2, 0), 0.5)], {
    prior: [clip()],
    since: [opacity(id(2, 0), 0.25)],
  });
  expect(reasons(setSince)).toEqual(["changed since"]);

  const removed = undoOf([remove], { prior: [clip(), opacity(id(2, 0), 0.5)] });
  expect(removed.ops).toEqual([opacity(id(2, 0), 0.5)]);
  const again = undoOf([remove], {
    prior: [clip(), opacity(id(2, 0), 0.5)],
    since: [opacity(id(2, 0), 0.75)],
  });
  expect(reasons(again)).toEqual(["set since"]);
});

test("an undo leaves alone a rename, restore, split or join changed since", () => {
  const disable = { op: "item.set" as const, id: id(2, 0), path: "enabled", value: false };
  const renamed = undoOf([{ op: "project.set", name: "x" }], {
    since: [{ op: "project.set", name: "y" }],
  });
  expect(reasons(renamed)).toEqual(["renamed since"]);

  const restored = undoOf([{ op: "item.restore", id: id(2, 0) }], {
    prior: [clip(), { op: "item.remove", id: id(2, 0) }],
  });
  expect(restored.ops).toEqual([{ op: "item.remove", id: id(2, 0) }]);
  const restoredSince = undoOf([{ op: "item.restore", id: id(2, 0) }], {
    prior: [clip(), { op: "item.remove", id: id(2, 0) }],
    since: [disable],
  });
  expect(reasons(restoredSince)).toEqual(["changed since"]);

  const split = undoOf([{ op: "clip.split", id: id(2, 0), at: SECOND }], {
    prior: [clip({ duration: 2 * SECOND })],
    since: [disable],
  });
  expect(reasons(split)).toEqual(["changed since"]);
  const join = undoOf([{ op: "clip.join", id: id(2, 0), next: id(2, 1) }], {
    prior: [clip({ duration: 2 * SECOND }), { op: "clip.split", id: id(2, 0), at: SECOND }],
    since: [disable],
  });
  expect(reasons(join)).toEqual(["changed since"]);
});

test("an undo can't restore a removed sequence, role or effect, and leaves branching alone", () => {
  const removes = undoOf(
    [
      { op: "effect.remove", id: id(2, 1) },
      { op: "role.remove", id: audio },
      { op: "sequence.remove", id: id(2, 2) },
    ],
    { prior: [clip(), effect(id(2, 0)), sequenceAdd] },
  );
  expect(removes.ops).toEqual([]);
  expect(reasons(removes)).toEqual(Array.from({ length: 3 }, () => "can't be restored"));

  // The history applies branching, not a project, so it is undone on documents it left as they were.
  const { project } = setUp();
  const branching: Op[] = [
    { op: "branch.create", name: "Alt" },
    { op: "branch.merge", branch: id(2, 0), through: { n: 1, hash: asset } },
    { op: "branch.close", branch: id(2, 0) },
  ];
  const undo = undoBatch({ author, seq: 2, ops: branching }, new Set(), {
    before: project,
    after: project,
    now: project,
  });
  expect(undo.ops).toEqual([]);
  expect(undo.left.map(({ reason }) => reason)).toEqual(
    Array.from({ length: 3 }, () => "not undone"),
  );
});

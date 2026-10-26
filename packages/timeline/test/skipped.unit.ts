// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Operations that no longer fit, or never could, in Chromium (src/edits.ts, src/placement.ts,
// src/leaf.ts): each is skipped with the kind of reason the design names, and the document is
// left as it was.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import type { ItemRecord } from "../src/document";
import { leafOf } from "../src/project";
import {
  asset,
  at,
  author,
  clip,
  FRAME,
  id,
  type Op,
  SECOND,
  sequence,
  setUp,
} from "./support/project";

type Source = Extract<ItemRecord, { kind: "clip" }>["source"];

const reasons = (result: { skipped: Array<{ index: number; reason: string }> }) =>
  result.skipped.map(({ index, reason }) => [index, reason]);

const effect: Op = {
  op: "effect.add",
  effect: { clip: id(2, 0), kind: "color.wheels", position: "a0", enabled: true, params: {} },
};

const sequenceAdd: Op = {
  op: "sequence.add",
  sequence: { name: "S", rate: [24, 1], width: 1920, height: 1080, sampleRate: 48_000 },
};

const roleOf = (of: string, order: string): Op => ({
  op: "role.add",
  role: { sequence: of, name: "V", kind: "video", color: "#000000", order },
});

test("a batch applied again adds nothing twice", () => {
  const { project, apply } = setUp();
  apply(clip());
  const ops = [clip({ anchor: at("a1") }), effect];
  const first = project.apply({ author, seq: 3, ops });
  expect(reasons(first)).toEqual([]);
  const again = project.apply({ author, seq: 3, ops });
  expect(reasons(again)).toEqual([
    [0, "stale"],
    [1, "stale"],
  ]);
  expect(project.storyline(sequence)).toHaveLength(2);
  expect(project.effects(id(2, 0))).toHaveLength(1);
});

test("restoring a live item or removing a removed asset is stale", () => {
  const { project, apply } = setUp();
  apply(clip());
  const result = apply(
    { op: "item.restore", id: id(2, 0) },
    { op: "asset.remove", id: id(2, 0) },
    { op: "item.remove", id: id(2, 0) },
    { op: "asset.remove", id: asset },
    { op: "asset.remove", id: asset },
  );
  expect(reasons(result)).toEqual([
    [0, "stale"],
    [1, "stale"],
    [4, "stale"],
  ]);
  expect(project.record(asset)?.removed).toBe(true);
});

test("a clip of a removed asset, or with another sequence's role, isn't added", () => {
  const { project, apply } = setUp();
  const { seq } = apply(sequenceAdd, roleOf(id(2, 0), "a0"));
  apply({ op: "asset.remove", id: asset });
  const result = apply(
    clip(),
    clip({ source: { generator: "solid", params: {} }, role: id(seq, 1) }),
  );
  expect(reasons(result)).toEqual([
    [0, "stale"],
    [1, "structural"],
  ]);
  expect(project.storyline(sequence)).toEqual([]);
});

test("a transition is placed by its cut, so moving it is malformed", () => {
  const { project, apply } = setUp();
  apply(
    clip(),
    {
      op: "item.add",
      item: { kind: "transition", cut: id(2, 0), duration: FRAME, effect: "dissolve", params: {} },
    },
    clip({ anchor: at("a1") }),
  );
  const result = apply({ op: "item.move", id: id(2, 1), anchor: at("a2") });
  expect(reasons(result)).toEqual([[0, "malformed"]]);
  expect(project.transitions(id(2, 0)).map((each) => each.id)).toEqual([id(2, 1)]);
});

test("a connected clip moved into the storyline takes its place there", () => {
  const { project, apply } = setUp();
  apply(clip(), clip({ anchor: { clip: id(2, 0), at: 0 }, lane: 1 }), clip({ anchor: at("a2") }));
  const result = apply({ op: "item.move", id: id(2, 1), anchor: at("a1") });
  expect(reasons(result)).toEqual([]);
  expect(project.storyline(sequence)).toEqual([
    { id: id(2, 0), start: 0, duration: SECOND },
    { id: id(2, 1), start: SECOND, duration: SECOND },
    { id: id(2, 2), start: 2 * SECOND, duration: SECOND },
  ]);
});

test("a leaf under a field that isn't an object can't be set", () => {
  const { project, apply } = setUp();
  apply(clip());
  const result = apply(
    { op: "item.set", id: id(2, 0), path: "video.missing.x", value: 1 },
    { op: "item.set", id: id(2, 0), path: "video.transform.x", value: 12 },
  );
  expect(reasons(result)).toEqual([[0, "malformed"]]);
  expect(leafOf(project.item(id(2, 0)) ?? {}, "video.transform.x")).toBe(12);
});

test("a leaf read past a value, or of an array, is what the record holds", () => {
  const record = { duration: 5, params: { lift: [0, 0.5, 1], names: [["a"], ["b"]] } };
  expect(leafOf(record, "duration.x")).toBeUndefined();
  expect(leafOf(record, "params.lift")).toEqual([0, 0.5, 1]);
  expect(leafOf(record, "params.names")).toEqual([["a"], ["b"]]);
  expect(leafOf(record, "params")).toBeUndefined();
});

test("a compound clip may play a sequence that plays another twice, but not one that plays its own", () => {
  const { apply } = setUp();
  // Sequences B, C and D, then a video role in each.
  const made = apply(sequenceAdd, sequenceAdd, sequenceAdd).seq;
  const [b, c, d] = [id(made, 0), id(made, 1), id(made, 2)];
  const roles = apply(roleOf(b, "a0"), roleOf(c, "a0"), roleOf(d, "a0")).seq;
  const inB = (source: Source, position: string) =>
    clip({ source, role: id(roles, 0), anchor: { storyline: b, position } });
  // B plays a generator, then C twice.
  const filled = apply(
    inB({ generator: "solid", params: {} }, "a0"),
    inB({ sequence: c }, "a1"),
    inB({ sequence: c }, "a2"),
  );
  expect(reasons(filled)).toEqual([]);

  const ofB = (into: string, role: string) =>
    clip({ source: { sequence: b }, role, anchor: { storyline: into, position: "a0" } });
  expect(reasons(apply(ofB(d, id(roles, 2))))).toEqual([]);
  expect(reasons(apply(ofB(c, id(roles, 1))))).toEqual([[0, "structural"]]);
});

test("a split that snaps back to a clip's start, or past the safe integers in its source, is skipped", () => {
  const { project, apply } = setUp();
  apply(
    // A connected video clip, whose pieces start on frames: one flick into it snaps back to its start.
    clip({ anchor: { origin: sequence, at: 0 }, lane: 1 }),
    // A generator whose source points are flicks, starting just short of the largest.
    clip({ source: { generator: "solid", params: {} }, in: Number.MAX_SAFE_INTEGER - 10 }),
  );
  const result = apply(
    { op: "clip.split", id: id(2, 0), at: 1 },
    { op: "clip.split", id: id(2, 1), at: SECOND / 2 },
  );
  expect(reasons(result)).toEqual([
    [0, "stale"],
    [1, "malformed"],
  ]);
  expect(project.item(id(2, 0))?.duration).toBe(SECOND);
  expect(project.item(id(2, 1))?.duration).toBe(SECOND);
});

test("a connected clip that carries on a storyline clip's source where it ends doesn't join it", () => {
  const { project, apply } = setUp();
  apply(clip(), clip({ anchor: { origin: sequence, at: SECOND }, lane: 1, in: 24_000 }));
  expect(reasons(apply({ op: "clip.join", id: id(2, 0), next: id(2, 1) }))).toEqual([[0, "stale"]]);
  expect(project.item(id(2, 0))?.duration).toBe(SECOND);
});

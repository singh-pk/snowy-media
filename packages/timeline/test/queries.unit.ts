// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// What a peer reads of a document (src/queries.ts, src/project.ts), in Chromium: ties in an
// order broken by id, and what reads of ids the document doesn't hold give.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { byCodeUnit } from "../src/records";
import { asset, at, clip, id, type Op, SECOND, sequence, setUp, video } from "./support/project";

const effect = (position: string): Op => ({
  op: "effect.add",
  effect: { clip: id(2, 0), kind: "color.wheels", position, enabled: true, params: {} },
});

const keyframe = (param: string, when: number): Op => ({
  op: "keyframe.set",
  keyframe: { target: id(2, 0), param, at: when, value: 1, ease: "linear" },
});

test("effects and roles in one place are ordered by id, and keyframes by param, then source point", () => {
  const { project, apply } = setUp();
  apply(clip());
  const { seq } = apply(effect("a1"), effect("a0"), effect("a0"));
  expect(project.effects(id(2, 0)).map((each) => each.id)).toEqual([
    id(seq, 1),
    id(seq, 2),
    id(seq, 0),
  ]);

  const roles = apply({
    op: "role.add",
    role: { sequence, name: "B", kind: "video", color: "#000000", order: "a0" },
  });
  // The set-up's video role is also at a0, and its id sorts first.
  expect(project.roles(sequence).map((each) => each.id)).toEqual([
    video,
    id(roles.seq, 0),
    id(1, 2),
  ]);

  apply(
    keyframe("video.opacity", 48),
    keyframe("video.transform.x", 0),
    keyframe("video.opacity", 0),
  );
  expect(project.keyframes(id(2, 0)).map((each) => [each.param, each.at])).toEqual([
    ["video.opacity", 0],
    ["video.opacity", 48],
    ["video.transform.x", 0],
  ]);
});

test("reading an asset by id, and ids the document never held", () => {
  const { project, apply } = setUp();
  apply(clip());
  expect(project.length(sequence)).toBe(SECOND);
  expect(project.record(asset)).toEqual({ record: project.asset(asset), removed: false });
  expect(project.record("nothing")).toBeUndefined();
  expect(project.itemBefore("nothing")).toBeUndefined();
  expect(project.length("nothing")).toBe(0);
});

test("a connected clip has no storyline item before it", () => {
  const { project, apply } = setUp();
  apply(clip(), clip({ anchor: at("a1") }), clip({ anchor: { clip: id(2, 1), at: 0 }, lane: 1 }));
  expect(project.itemBefore(id(2, 1))?.id).toBe(id(2, 0));
  expect(project.itemBefore(id(2, 2))).toBeUndefined();
});

test("ids are ordered by UTF-16 code unit, not by locale or code point", () => {
  expect(byCodeUnit("Z", "a")).toBe(-1);
  expect(byCodeUnit("a", "a")).toBe(0);
  // U+FFFF is after U+1F600's first code unit, D83D.
  expect(byCodeUnit("\uFFFF", "😀")).toBe(1);
});

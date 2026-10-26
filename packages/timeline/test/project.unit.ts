// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Applying item operations (src/apply.ts, src/edits.ts), in Chromium: operations that fit change
// the document, the rest are skipped with their reason, and applying reports what changed.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import {
  asset,
  at,
  audio,
  author,
  clip,
  FRAME,
  id,
  innerSequence,
  SECOND,
  sequence,
  setUp,
  video,
  type Op,
} from "./support/project";

test("storyline items follow each other by position", () => {
  const { project, apply } = setUp();
  const { seq } = apply(
    clip({ anchor: at("a1") }),
    clip({ anchor: at("a0"), duration: 2 * SECOND }),
  );
  expect(project.start(id(seq, 1))).toBe(0);
  expect(project.start(id(seq, 0))).toBe(2 * SECOND);
  expect(project.storyline(sequence).map((placed) => placed.id)).toEqual([id(seq, 1), id(seq, 0)]);
});

test("a connected clip sits at a source point of its clip", () => {
  const { project, apply } = setUp();
  const { seq } = apply(
    clip({ in: 24_000 }),
    clip({ anchor: { clip: id(2, 0), at: 36_000 }, role: video, lane: 1 }),
  );
  expect(seq).toBe(2);
  // Half a second into the clip's media, which starts one second in.
  expect(project.start(id(2, 1))).toBe(SECOND / 2);
  // Trimming the clip's head keeps the connected clip on the same moment of the media.
  apply({ op: "item.set", id: id(2, 0), path: "in", value: 12_000 });
  expect(project.start(id(2, 1))).toBe(SECOND);
});

test("an origin anchor snaps a video clip down to a frame", () => {
  const { project, apply } = setUp();
  const { seq } = apply(clip({ anchor: { origin: sequence, at: FRAME + 5 } }));
  expect(project.start(id(seq, 0))).toBe(FRAME);
});

test("an operation that doesn't fit is skipped, and the rest apply", () => {
  const { project, apply } = setUp();
  const result = apply(
    clip(),
    { op: "item.set", id: id(9, 9), path: "duration", value: 1 },
    { op: "item.set", id: id(2, 0), path: "kind", value: "gap" },
    { op: "item.set", id: id(2, 0), path: "duration", value: -1 },
    { op: "branch.close", branch: "main" },
    { op: "item.set", id: id(2, 0), path: "duration", value: 2 * SECOND },
  );
  expect(result.skipped.map(({ index, reason }) => [index, reason])).toEqual([
    [1, "stale"],
    [2, "malformed"],
    [3, "malformed"],
    [4, "unsupported"],
  ]);
  expect(project.item(id(2, 0))?.duration).toBe(2 * SECOND);
  expect(result.changed).toEqual([id(2, 0)]);
});

test("setting one leaf of absent video fields fills in the rest", () => {
  const { project, apply } = setUp();
  apply(clip());
  apply({ op: "item.set", id: id(2, 0), path: "video.transform.x", value: 10 });
  const item = project.item(id(2, 0));
  expect(item?.kind === "clip" ? item.video : undefined).toEqual({
    opacity: 1,
    blend: "normal",
    transform: { x: 10, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  });
});

test("connected items anchor only to storyline clips", () => {
  const { apply } = setUp();
  const result = apply(
    clip(),
    clip({ anchor: { clip: id(2, 0), at: 0 }, lane: 1 }),
    clip({ anchor: { clip: id(2, 1), at: 0 }, lane: 2 }),
    {
      op: "item.add",
      item: { kind: "gap", anchor: { storyline: sequence, position: "a1" }, duration: SECOND },
    },
    clip({ anchor: { clip: id(2, 3), at: 0 }, lane: 2 }),
    {
      op: "item.add",
      item: { kind: "marker", anchor: at("a2"), duration: 0, type: "marker", name: "m" },
    },
    {
      op: "item.add",
      item: { kind: "gap", anchor: { origin: sequence, at: 0 }, duration: SECOND },
    },
  );
  expect(result.skipped.map(({ index, reason }) => [index, reason])).toEqual([
    [2, "structural"],
    [4, "structural"],
    [5, "structural"],
    [6, "structural"],
  ]);
});

test("a clip's role must be of its sequence and take its kind of media", () => {
  const { apply } = setUp();
  const result = apply(
    clip({ role: audio }),
    clip({ source: { asset, stream: 1 }, role: audio, anchor: { origin: sequence, at: 0 } }),
    clip({ role: id(9, 9) }),
    clip({ source: { asset, stream: 7 } }),
    clip({ source: { generator: "solid", params: { color: "#ffffff" } } }),
  );
  expect(result.skipped.map(({ index, reason }) => [index, reason])).toEqual([
    [0, "structural"],
    [2, "stale"],
    [3, "stale"],
  ]);
});

test("a compound clip can't contain its own sequence", () => {
  const { apply } = setUp();
  const { seq } = apply(...innerSequence(2));
  const inner = id(seq, 0);
  const innerRole = id(seq, 1);
  const result = apply(
    clip({ source: { sequence: inner } }),
    clip({
      source: { sequence: sequence },
      role: innerRole,
      anchor: { storyline: inner, position: "a0" },
    }),
    clip({ source: { sequence: sequence } }),
  );
  expect(result.skipped.map(({ index, reason }) => [index, reason])).toEqual([
    [1, "structural"],
    [2, "structural"],
  ]);
});

test("a storyline clip can leave the storyline only once nothing is connected to it", () => {
  const { project, apply } = setUp();
  apply(clip(), clip({ anchor: { clip: id(2, 0), at: 0 }, lane: 1 }));
  const off = { op: "item.move" as const, id: id(2, 0), anchor: { origin: sequence, at: 0 } };
  expect(apply(off).skipped.map(({ reason }) => reason)).toEqual(["structural"]);
  // Re-anchoring the connected clip earlier in the same batch makes the move fit.
  const result = apply({ op: "item.move", id: id(2, 1), anchor: { origin: sequence, at: 0 } }, off);
  expect(result.skipped).toEqual([]);
  expect(project.storyline(sequence)).toEqual([]);
});

test("items move only within their sequence", () => {
  const { apply } = setUp();
  const { seq } = apply({
    op: "sequence.add",
    sequence: { name: "Other", rate: [24, 1], width: 1920, height: 1080, sampleRate: 48_000 },
  });
  apply(clip());
  const result = apply({
    op: "item.move",
    id: id(3, 0),
    anchor: { storyline: id(seq, 0), position: "a0" },
  });
  expect(result.skipped.map(({ reason }) => reason)).toEqual(["structural"]);
});

test("a removed storyline clip closes up, and its connected items become orphans in place", () => {
  const { project, apply } = setUp();
  apply(
    clip(),
    clip({ anchor: at("a1") }),
    clip({ anchor: { clip: id(2, 1), at: 12_000 }, lane: 1 }),
  );
  expect(project.start(id(2, 2))).toBe(SECOND + SECOND / 2);
  const removed = apply({ op: "item.remove", id: id(2, 0) });
  expect(removed.ranges.get(sequence)).toEqual({ from: 0, to: Number.POSITIVE_INFINITY });
  expect(project.start(id(2, 1))).toBe(0);
  apply({ op: "item.remove", id: id(2, 1) });
  expect(project.item(id(2, 2))?.orphaned).toBe(true);
  expect(project.start(id(2, 2))).toBe(SECOND / 2);
  expect(project.storyline(sequence)).toEqual([]);
  // A new item can't anchor to a removed clip, but restoring it brings everything back.
  expect(
    apply(clip({ anchor: { clip: id(2, 1), at: 0 } })).skipped.map(({ reason }) => reason),
  ).toEqual(["stale"]);
  apply({ op: "item.restore", id: id(2, 1) }, { op: "item.restore", id: id(2, 0) });
  expect(project.start(id(2, 1))).toBe(SECOND);
  expect(project.item(id(2, 2))?.orphaned).toBe(false);
});

test("a role in use can't be removed", () => {
  const { project, apply } = setUp();
  apply(clip());
  expect(apply({ op: "role.remove", id: video }).skipped.map(({ reason }) => reason)).toEqual([
    "structural",
  ]);
  apply({ op: "item.remove", id: id(2, 0) }, { op: "role.remove", id: video });
  // Restoring the clip finds its role gone.
  expect(apply({ op: "item.restore", id: id(2, 0) }).skipped.map(({ reason }) => reason)).toEqual([
    "stale",
  ]);
  expect(project.item(id(2, 0))?.removed).toBe(true);
});

test("a marker's change reports the range it covered before and after", () => {
  const { apply } = setUp();
  apply({
    op: "item.add",
    item: {
      kind: "marker",
      anchor: { origin: sequence, at: SECOND },
      duration: SECOND,
      type: "marker",
      name: "m",
    },
  });
  const result = apply({
    op: "item.move",
    id: id(2, 0),
    anchor: { origin: sequence, at: 3 * SECOND },
  });
  expect(result.ranges.get(sequence)).toEqual({ from: SECOND, to: 4 * SECOND });
});

test("a connected clip's change reports all after it, since later clips can change lanes", () => {
  const { apply } = setUp();
  apply(clip({ anchor: { origin: sequence, at: SECOND } }));
  const result = apply({ op: "item.set", id: id(2, 0), path: "lane", value: 3 });
  expect(result.ranges.get(sequence)).toEqual({ from: SECOND, to: Number.POSITIVE_INFINITY });
});

test("trimming a clip's head reports where its connected items were, even before it", () => {
  const { project, apply } = setUp();
  apply(
    clip({ in: 24_000 }),
    clip({ anchor: at("a1"), in: 24_000 }),
    clip({ anchor: { clip: id(2, 1), at: 0 }, lane: 1 }),
  );
  expect(project.start(id(2, 2))).toBe(0);
  const result = apply({ op: "item.set", id: id(2, 1), path: "in", value: 48_000 });
  expect(project.start(id(2, 2))).toBe(-SECOND);
  expect(result.ranges.get(sequence)).toEqual({ from: -SECOND, to: Number.POSITIVE_INFINITY });
});

test("a role's order or a sequence's settings redraw the whole sequence", () => {
  const { project, apply } = setUp();
  const named = apply({ op: "role.set", id: video, path: "name", value: "Pictures" });
  expect(named.ranges.size).toBe(0);
  expect(project.role(video)?.name).toBe("Pictures");
  const ordered = apply({ op: "role.set", id: video, path: "order", value: "a2" });
  expect(ordered.ranges.get(sequence)).toEqual({
    from: Number.NEGATIVE_INFINITY,
    to: Number.POSITIVE_INFINITY,
  });
  const resized = apply({ op: "sequence.set", id: sequence, path: "width", value: 1280 });
  expect(resized.ranges.get(sequence)).toEqual({
    from: Number.NEGATIVE_INFINITY,
    to: Number.POSITIVE_INFINITY,
  });
});

test("a time past the safe integers is skipped, and changes nothing", () => {
  const { project, apply } = setUp();
  const half = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1;
  const result = apply(
    clip(),
    clip({ anchor: { clip: id(2, 0), at: Number.MAX_SAFE_INTEGER }, lane: 1 }),
    clip({ anchor: at("a1"), duration: half }),
    clip({ anchor: at("a2"), duration: half }),
    { op: "item.set", id: id(2, 2), path: "duration", value: Number.MAX_SAFE_INTEGER },
    { op: "item.set", id: id(2, 0), path: "duration", value: 2 * SECOND },
  );
  expect(result.skipped.map(({ index, reason }) => [index, reason])).toEqual([
    [1, "malformed"],
    [3, "malformed"],
    [4, "malformed"],
  ]);
  expect(project.item(id(2, 1))).toBeUndefined();
  expect(project.item(id(2, 3))).toBeUndefined();
  expect(project.item(id(2, 2))?.duration).toBe(half);
  expect(project.storyline(sequence).map((placed) => placed.id)).toEqual([id(2, 0), id(2, 2)]);
});

test("a connected item whose end would pass the safe integers is skipped", () => {
  const { project, apply } = setUp();
  const late = Number.MAX_SAFE_INTEGER - 2 * SECOND;
  const result = apply(
    clip({ anchor: { origin: sequence, at: late }, duration: 100 * SECOND }),
    clip({ anchor: { origin: sequence, at: late } }),
    { op: "item.set", id: id(2, 1), path: "duration", value: Number.MAX_SAFE_INTEGER },
  );
  expect(result.skipped.map(({ index, reason }) => [index, reason])).toEqual([
    [0, "malformed"],
    [2, "malformed"],
  ]);
  expect(project.item(id(2, 1))?.duration).toBe(SECOND);
});

test("a storyline item keeps its place while a transition sits on it", () => {
  const { project, apply } = setUp();
  apply(clip(), clip({ anchor: at("a1") }), {
    op: "item.add",
    item: {
      kind: "transition",
      cut: id(2, 0),
      duration: 2 * FRAME,
      effect: "cross.dissolve",
      params: {},
    },
  });
  const off = { op: "item.move" as const, id: id(2, 0), anchor: { origin: sequence, at: 0 } };
  expect(apply(off).skipped.map(({ reason }) => reason)).toEqual(["structural"]);
  // Removing the cut hides the transition until the cut is restored.
  apply({ op: "item.remove", id: id(2, 0) });
  expect(project.start(id(2, 2))).toBeUndefined();
  expect(apply({ op: "item.set", id: id(2, 2), path: "duration", value: FRAME }).skipped).toEqual(
    [],
  );
});

test("an asset in use can't be removed, and adding it again takes the new record", () => {
  const { project, apply } = setUp();
  apply(clip());
  expect(apply({ op: "asset.remove", id: asset }).skipped.map(({ reason }) => reason)).toEqual([
    "structural",
  ]);
  apply({ op: "item.remove", id: id(2, 0) });
  expect(apply({ op: "asset.remove", id: asset }).skipped).toEqual([]);
  const record = project.asset(asset);
  if (record === undefined) throw new Error("no asset");
  expect(apply({ op: "asset.add", asset: { ...record, name: "b.mp4" } }).skipped).toEqual([]);
  expect(project.asset(asset)?.name).toBe("b.mp4");
  expect(apply({ op: "asset.add", asset: record }).skipped.map(({ reason }) => reason)).toEqual([
    "stale",
  ]);
});

test("a sequence that holds items, or that a compound clip plays, can't be removed", () => {
  const { apply } = setUp();
  const { seq } = apply({
    op: "sequence.add",
    sequence: { name: "Inner", rate: [24, 1], width: 1920, height: 1080, sampleRate: 48_000 },
  });
  const inner = id(seq, 0);
  apply(clip({ source: { sequence: inner } }));
  const reasons = (ops: Op[]) => apply(...ops).skipped.map(({ reason }) => reason);
  expect(reasons([{ op: "sequence.remove", id: sequence }])).toEqual(["structural"]);
  expect(reasons([{ op: "sequence.remove", id: inner }])).toEqual(["structural"]);
  expect(
    reasons([
      { op: "item.remove", id: id(3, 0) },
      { op: "sequence.remove", id: inner },
    ]),
  ).toEqual([]);
  expect(reasons([{ op: "item.restore", id: id(3, 0) }])).toEqual(["stale"]);
});

test("an orphan can't come back to life in a removed sequence", () => {
  const { apply } = setUp();
  const { seq } = apply(
    {
      op: "sequence.add",
      sequence: { name: "Other", rate: [24, 1], width: 1920, height: 1080, sampleRate: 48_000 },
    },
    {
      op: "role.add",
      role: { sequence: id(2, 0), name: "V", kind: "video", color: "#000000", order: "a0" },
    },
  );
  const other = id(seq, 0);
  const role = id(seq, 1);
  apply(
    clip({ anchor: { storyline: other, position: "a0" }, role }),
    clip({ anchor: { clip: id(3, 0), at: 0 }, role, lane: 1 }),
  );
  const result = apply(
    { op: "item.remove", id: id(3, 1) },
    { op: "item.remove", id: id(3, 0) },
    { op: "sequence.remove", id: other },
    { op: "item.restore", id: id(3, 1) },
  );
  expect(result.skipped.map(({ index, reason }) => [index, reason])).toEqual([[3, "stale"]]);
});

test("applying a batch again adds nothing twice", () => {
  const { project } = setUp();
  const ops: Op[] = [
    { op: "project.set", name: "Film" },
    {
      op: "sequence.add",
      sequence: { name: "Other", rate: [24, 1], width: 1920, height: 1080, sampleRate: 48_000 },
    },
    {
      op: "role.add",
      role: { sequence, name: "Titles", kind: "video", color: "#ffffff", order: "a3" },
    },
  ];
  expect(project.apply({ author, seq: 9, ops }).skipped).toEqual([]);
  expect(project.name()).toBe("Film");
  expect(project.apply({ author, seq: 9, ops }).skipped.map(({ reason }) => reason)).toEqual([
    "stale",
    "stale",
  ]);
});

test("a generator clip's parameters are set by path", () => {
  const { project, apply } = setUp();
  apply(clip({ source: { generator: "solid", params: { color: "#ffffff" } } }));
  const result = apply(
    { op: "item.set", id: id(2, 0), path: "source.params.color", value: "#000000" },
    { op: "item.set", id: id(2, 0), path: "source.generator", value: "text" },
  );
  expect(result.skipped.map(({ index, reason }) => [index, reason])).toEqual([[1, "malformed"]]);
  const item = project.item(id(2, 0));
  expect(item?.kind === "clip" ? item.source : undefined).toEqual({
    generator: "solid",
    params: { color: "#000000" },
  });
});

test("lanes stack connected clips of a role that overlap", () => {
  const { project, apply } = setUp();
  apply(
    clip({ anchor: { origin: sequence, at: 0 }, duration: 2 * SECOND }),
    clip({ anchor: { origin: sequence, at: SECOND } }),
    clip({ anchor: { origin: sequence, at: 2 * SECOND } }),
  );
  const lanes = project.lanes(video);
  expect([lanes.get(id(2, 0)), lanes.get(id(2, 1)), lanes.get(id(2, 2))]).toEqual([0, 1, 0]);
});

test("a frame rate that isn't whole flicks is skipped", () => {
  const { project, apply } = setUp();
  const result = apply({ op: "sequence.set", id: sequence, path: "rate", value: [11, 1] });
  expect(result.skipped.map(({ reason }) => reason)).toEqual(["malformed"]);
  expect(project.sequence(sequence)?.rate).toEqual([24, 1]);
  expect(
    apply({ op: "role.set", id: video, path: "sequence", value: id(9, 9) }).skipped,
  ).toHaveLength(1);
});

const transition = (cut: string): Op => ({
  op: "item.add",
  item: { kind: "transition", cut, duration: 2 * FRAME, effect: "cross.dissolve", params: {} },
});

test("a transition sits on its cut and needs a storyline item", () => {
  const { project, apply } = setUp();
  apply(clip(), clip({ anchor: at("a1") }), clip({ anchor: { origin: sequence, at: 0 }, lane: 1 }));
  const result = apply(transition(id(2, 0)), transition(id(2, 2)));
  expect(result.skipped.map(({ index, reason }) => [index, reason])).toEqual([[1, "structural"]]);
  expect(project.start(id(result.seq, 0))).toBe(SECOND - FRAME);
  // An odd frame goes after the cut.
  const odd = apply({ op: "item.set", id: id(result.seq, 0), path: "duration", value: 3 * FRAME });
  expect(odd.skipped).toEqual([]);
  expect(project.start(id(result.seq, 0))).toBe(SECOND - FRAME);
});

test("a storyline in a range lists what plays in it or starts at its end, as the whole list does", () => {
  const { project, apply } = setUp();
  apply(clip({ anchor: at("a0") }), clip({ anchor: at("a1") }), clip({ anchor: at("a2") }));
  apply({ op: "item.remove", id: id(2, 1) });
  const whole = project.storyline(sequence);
  const within = (from: number, to: number) =>
    whole.filter(({ start, duration }) => start + duration > from && start <= to);

  for (const [from, to] of [
    [0, SECOND / 2],
    [SECOND, SECOND],
    [SECOND / 2, 2 * SECOND],
    [3 * SECOND, 4 * SECOND],
  ] as const) {
    expect(project.storyline(sequence, { from, to })).toEqual(within(from, to));
  }
});

test("the item before a storyline item passes over removed ones", () => {
  const { project, apply } = setUp();
  apply(clip({ anchor: at("a0") }), clip({ anchor: at("a1") }), clip({ anchor: at("a2") }));
  apply({ op: "item.remove", id: id(2, 1) });
  expect(project.itemBefore(id(2, 2))).toEqual({ id: id(2, 0), start: 0, duration: SECOND });
  expect(project.itemBefore(id(2, 0))).toBe(undefined);
});

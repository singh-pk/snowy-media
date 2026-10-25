// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The storyline's layout (src/storyline.ts), in Chromium: items are ordered by position key and
// id, each starts where the ones before it end, removing or shortening an item closes up what
// follows, and thousands of random edits agree with laying the storyline out from scratch.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { keyBetween } from "../src/position";
import { createStoryline, type Placed } from "../src/storyline";

// A seeded sequence of numbers in [0, 1), so the test is the same on every run.
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

// a, b, c… in order, each `duration` long.
function storylineOf(durations: number[]) {
  const storyline = createStoryline();
  let position: string | undefined;

  for (const [i, duration] of durations.entries()) {
    position = keyBetween(position);
    storyline.insert(String.fromCharCode(97 + i), position, duration);
  }

  return storyline;
}

test("each item starts where the ones before it end", () => {
  const storyline = storylineOf([10, 20, 30]);
  expect([...storyline.items()]).toEqual([
    { id: "a", start: 0, duration: 10 },
    { id: "b", start: 10, duration: 20 },
    { id: "c", start: 30, duration: 30 },
  ]);
  expect(storyline.start("c")).toBe(30);
  expect(storyline.duration()).toBe(60);
  expect(storyline.size).toBe(3);
});

test("an item inserted between two pushes what follows along", () => {
  const storyline = storylineOf([10, 20]);
  storyline.insert("x", keyBetween("a0", "a1"), 5);
  expect([...storyline.items()].map((item) => item.id)).toEqual(["a", "x", "b"]);
  expect(storyline.start("b")).toBe(15);
});

test("items at the same position key are ordered by id", () => {
  const storyline = createStoryline();
  storyline.insert("b", "a0", 1);
  storyline.insert("a", "a0", 2);
  expect([...storyline.items()].map((item) => item.id)).toEqual(["a", "b"]);
  expect(storyline.start("b")).toBe(2);
});

test("removing or shortening an item closes up what follows", () => {
  const storyline = storylineOf([10, 20, 30]);
  storyline.remove("a");
  expect(storyline.start("c")).toBe(20);
  storyline.setDuration("b", 5);
  expect(storyline.start("c")).toBe(5);
  expect(storyline.has("a")).toBe(false);
});

test("moving an item closes up where it was and moves along what follows where it lands", () => {
  const storyline = storylineOf([10, 20, 30]);
  storyline.move("a", keyBetween("a2"));
  expect([...storyline.items()]).toEqual([
    { id: "b", start: 0, duration: 20 },
    { id: "c", start: 20, duration: 30 },
    { id: "a", start: 50, duration: 10 },
  ]);
});

test("the item at a time is the one that covers it; an item of no length covers nothing", () => {
  const storyline = storylineOf([10, 0, 20]);
  expect(storyline.at(0)).toEqual({ id: "a", start: 0, duration: 10 });
  expect(storyline.at(9)).toEqual({ id: "a", start: 0, duration: 10 });
  expect(storyline.at(10)).toEqual({ id: "c", start: 10, duration: 20 });
  expect(storyline.at(30)).toBeUndefined();
  expect(storyline.at(-1)).toBeUndefined();
  expect(storyline.start("b")).toBe(10);
});

test("the key after a position skips items tied at it", () => {
  const storyline = createStoryline();
  storyline.insert("x", "a0", 1);
  storyline.insert("y", "a0", 1);
  storyline.insert("z", "a5", 1);
  expect(storyline.keyAfter("a0")).toBe("a5");
  expect(storyline.keyAfter("a1")).toBe("a5");
  expect(storyline.keyAfter("a5")).toBeUndefined();
  expect([storyline.next("x"), storyline.next("y"), storyline.next("z")]).toEqual([
    "y",
    "z",
    undefined,
  ]);
});

test("an id is in a storyline once, and only items in it can be changed", () => {
  const storyline = storylineOf([10]);
  expect(() => storyline.insert("a", "a5", 1)).toThrow(RangeError);
  expect(() => storyline.remove("z")).toThrow(RangeError);
  expect(() => storyline.start("z")).toThrow(RangeError);
  expect(() => storyline.setDuration("a", -1)).toThrow(RangeError);
  expect(() => storyline.insert("b", "a5", 0.5)).toThrow(RangeError);
  expect(() => storyline.insert("b", "a5", Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
  storyline.setDuration("a", Number.MAX_SAFE_INTEGER);
  expect(storyline.duration()).toBe(Number.MAX_SAFE_INTEGER);
  expect(storyline.has("b")).toBe(false);
});

test("thousands of random edits agree with laying the storyline out from scratch", () => {
  const next = random(7);
  const storyline = createStoryline();
  const model = new Map<string, { position: string; duration: number }>();
  const keys: string[] = [];
  const pick = () => [...model.keys()][Math.floor(next() * model.size)] ?? "";

  function freshKey() {
    const at = Math.floor(next() * (keys.length + 1));
    const key = keyBetween(keys[at - 1], keys[at]);
    keys.splice(at, 0, key);
    return key;
  }

  for (let i = 0; i < 3000; i += 1) {
    // An AVL tree of n items is never taller than 1.45 log2(n + 2).
    expect(storyline.height()).toBeLessThan(1.45 * Math.log2(storyline.size + 2));
    const action = next();
    const duration = Math.floor(next() * 1000);

    if (model.size === 0 || action < 0.4) {
      const position = freshKey();
      storyline.insert(`i${i}`, position, duration);
      model.set(`i${i}`, { position, duration });
    } else if (action < 0.6) {
      const id = pick();
      storyline.remove(id);
      model.delete(id);
    } else if (action < 0.8) {
      const id = pick();
      const position = freshKey();
      storyline.move(id, position);
      model.set(id, { position, duration: model.get(id)?.duration ?? 0 });
    } else {
      const id = pick();
      storyline.setDuration(id, duration);
      model.set(id, { position: model.get(id)?.position ?? "", duration });
    }
  }

  let start = 0;
  const expected: Placed[] = [];
  const ordered = [...model].toSorted(([a, x], [b, y]) =>
    x.position === y.position ? (a < b ? -1 : 1) : x.position < y.position ? -1 : 1,
  );

  for (const [id, { duration }] of ordered) {
    expected.push({ id, start, duration });
    start += duration;
  }

  expect([...storyline.items()]).toEqual(expected);
  expect(storyline.duration()).toBe(start);

  for (const item of expected) expect(storyline.start(item.id)).toBe(item.start);

  // An empty clip covers no time, so only clips with a duration are found at a time.
  for (const item of expected.filter((i) => i.duration > 0)) {
    expect(storyline.at(item.start + item.duration - 1)?.id).toBe(item.id);
  }
});

test("a storyline of 100,000 clips appended one at a time stays balanced", () => {
  // Unbalanced, the tree would be a list: inserting would recurse 100,000 deep and overflow.
  const storyline = createStoryline();
  let position: string | undefined;

  for (let i = 0; i < 100_000; i += 1) {
    position = keyBetween(position);
    storyline.insert(`i${i}`, position, 1);
  }

  expect(storyline.start("i99999")).toBe(99_999);
  expect(storyline.at(50_000)?.id).toBe("i50000");
});

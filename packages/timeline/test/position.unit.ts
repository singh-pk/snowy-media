// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Position keys (src/position.ts), in Chromium: a key always fits between two others, the same
// inputs give the same key, appending keeps keys short, and keys inserted together stay in
// order between their neighbours.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { isPositionKey, keyBetween, keysBetween } from "../src/position";

// A seeded sequence of numbers in [0, 1), so the test is the same on every run.
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

function expectAscending(keys: string[]) {
  for (let i = 1; i < keys.length; i += 1) {
    expect((keys[i - 1] ?? "") < (keys[i] ?? "")).toBe(true);
  }
}

test("the first key, and keys after, before and between it", () => {
  expect(keyBetween()).toBe("a0");
  expect(keyBetween("a0")).toBe("a1");
  expect(keyBetween(undefined, "a0")).toBe("Zz");
  expect(keyBetween("a0", "a1")).toBe("a0V");
  expect(keyBetween("a0", "a0V")).toBe("a0G");
  expect(keyBetween("a0V", "a1")).toBe("a0l");
});

test("stepping past the last digit lengthens the integer part", () => {
  expect(keyBetween("az")).toBe("b00");
  expect(keyBetween("Zz")).toBe("a0");
  expect(keyBetween(undefined, "Z0")).toBe("Yzz");
});

test("the key before the smallest integer but one is a fraction, never the smallest integer", () => {
  const key = keyBetween(undefined, `A${"0".repeat(25)}1`);
  expect(key).toBe(`A${"0".repeat(26)}V`);
  expect(isPositionKey(key)).toBe(true);
  expect(isPositionKey(keyBetween(undefined, key))).toBe(true);
});

test("a key can't be made unless the first key is before the second", () => {
  expect(() => keyBetween("a1", "a0")).toThrow(RangeError);
  expect(() => keyBetween("a0", "a0")).toThrow(RangeError);
  expect(() => keyBetween("a00")).toThrow(RangeError);
});

test("only well-formed keys are keys", () => {
  for (const key of ["a0", "a0V", "Zz", "b00", "zzzzzzzzzzzzzzzzzzzzzzzzzzz"]) {
    expect(isPositionKey(key)).toBe(true);
  }

  for (const key of ["", "a", "a00", "a0V0", "b0", "a0.", "!0", `A${"0".repeat(26)}`]) {
    expect(isPositionKey(key)).toBe(false);
  }
});

test("appending ten thousand clips one at a time keeps keys four characters long", () => {
  const keys = [keyBetween()];
  while (keys.length < 10_000) keys.push(keyBetween(keys.at(-1)));
  expectAscending(keys);
  expect(Math.max(...keys.map((key) => key.length))).toBe(4);
});

test("prepending keeps keys short too", () => {
  const keys = [keyBetween()];
  while (keys.length < 10_000) keys.unshift(keyBetween(undefined, keys[0]));
  expectAscending(keys);
  expect(Math.max(...keys.map((key) => key.length))).toBe(4);
});

test("inserting anywhere, again and again, always fits a key between its neighbours", () => {
  const next = random(1);
  const keys: string[] = [];

  for (let i = 0; i < 2000; i += 1) {
    const at = Math.floor(next() * (keys.length + 1));
    const key = keyBetween(keys[at - 1], keys[at]);
    expect(isPositionKey(key)).toBe(true);
    keys.splice(at, 0, key);
  }

  expectAscending(keys);
});

test("the same neighbours always give the same key", () => {
  expect(keyBetween("a0", "a0G")).toBe(keyBetween("a0", "a0G"));
  expect(keysBetween("a0", "a1", 9)).toEqual(keysBetween("a0", "a1", 9));
});

test("keys inserted together are in order, between their neighbours", () => {
  expect(keysBetween(undefined, undefined, 3)).toEqual(["a0", "a1", "a2"]);
  expect(keysBetween(undefined, "a0", 2)).toEqual(["Zy", "Zz"]);
  expect(keysBetween("a0", "a1", 0)).toEqual([]);

  const keys = keysBetween("a0", "a1", 100);
  expect(keys).toHaveLength(100);
  expectAscending(["a0", ...keys, "a1"]);
  expect(Math.max(...keys.map((key) => key.length))).toBeLessThan(6);
});

test("keys at the edges of an integer part, of a fraction and of the key space", () => {
  // The integer after Yzz is Z0, and the one before b00 is az, each one digit shorter.
  expect(keyBetween("Yzz")).toBe("Z0");
  expect(keyBetween(undefined, "b00")).toBe("az");
  // Before a key with a fraction comes its integer alone.
  expect(keyBetween(undefined, "a0V")).toBe("a0");
  // V and W are adjacent digits, so between a0V and a0W5 is a0W.
  expect(keyBetween("a0V", "a0W5")).toBe("a0W");
  // Past the largest integer, keys go on as fractions of it.
  const largest = "z".repeat(27);
  expect(keyBetween(largest)).toBe(`${largest}V`);
  expect(() => keysBetween("a0", "a1", -1)).toThrow(RangeError);
  expect(() => keysBetween("a0", "a1", 1.5)).toThrow(RangeError);
});

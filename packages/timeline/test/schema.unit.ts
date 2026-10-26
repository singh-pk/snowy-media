// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The schema combinators (src/schema.ts), in Chromium: what each refuses, and where it says the
// refused value was, and an open record's keys put in code-point order.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import {
  boolean,
  either,
  integer,
  InvalidError,
  map,
  pair,
  type Schema,
  string,
  union,
} from "../src/schema";

// Why `schema` refuses `value` at `x`, or "accepted".
function refusal(schema: Schema<unknown>, value: unknown) {
  try {
    schema(value, "x");
  } catch (error) {
    if (error instanceof InvalidError) return error.message;
    throw error;
  }

  return "accepted";
}

test("a string, boolean or pair of the wrong shape is refused", () => {
  expect(refusal(string(undefined, 3), "abcd")).toBe("x: longer than 3");
  expect(refusal(string(undefined, 3), "abc")).toBe("accepted");
  expect(refusal(boolean, 0)).toBe("x: not a boolean");
  expect(refusal(pair(integer(), integer()), [1])).toBe("x: not a pair");
  expect(refusal(pair(integer(), integer()), { 0: 1, 1: 2 })).toBe("x: not a pair");
});

test("an open record refuses anything but an object, too many keys and a key of another shape", () => {
  const counts = map(/^[a-z]+$/, integer(), 2);
  expect(refusal(counts, [])).toBe("x: not an object");
  expect(refusal(counts, { a: 1, b: 2, c: 3 })).toBe("x: more than 2 keys");
  expect(refusal(counts, { a: 1, B: 2 })).toBe("x: bad key B");
  expect(refusal(counts, { a: "1" })).toBe("x.a: not an integer");
});

test("an open record's keys come back in code-point order, which differs from UTF-16's past U+FFFF", () => {
  const any = map(/^/u, integer());
  // U+1F600 is the surrogates D83D DE00: before U+FFFF by code unit, after it by code point.
  const checked = any({ "😀b": 1, "\uFFFF": 2, "😀a": 3, ab: 4, a: 5 }, "");
  expect(Object.keys(checked)).toEqual(["a", "ab", "\uFFFF", "😀a", "😀b"]);
});

test("a union refuses anything but an object and a tag it doesn't know, at the tag", () => {
  const shapes = union("kind", { dot: (value) => value });
  expect(refusal(shapes, "dot")).toBe("x: not an object");
  expect(refusal(shapes, { kind: "line" })).toBe("x.kind: unknown");
  expect(refusal(shapes, { kind: "toString" })).toBe("x.kind: unknown");
  expect(() => shapes({ kind: 1 }, "")).toThrow("kind: unknown");
});

// A schema that fails as a bug would, not by refusing.
const broken: Schema<never> = () => {
  throw new TypeError("broken");
};

test("either passes on an error that isn't a refusal rather than trying the next option", () => {
  const tried: string[] = [];

  const next: Schema<string> = (value) => {
    tried.push("next");
    return String(value);
  };

  expect(() => either([broken, next], "neither")(1, "x")).toThrow(TypeError);
  expect(tried).toEqual([]);
  expect(refusal(either([boolean, integer()], "neither"), "1")).toBe("x: neither");
});

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Framing an object with its key for the relay (src/relay.ts), in Chromium: it comes back as it
// went, from any offset, and bytes too short for their key length are no object. Tracks rank as
// docs/architecture.md#mapping-to-moq lists them.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { frame, priority, unframe } from "../src/relay";

const bytes = (...values: number[]) => new Uint8Array(values);

test("an object comes back with its key", () => {
  const framed = frame("chat/a/1-2", bytes(1, 2, 3));
  const object = unframe(framed);
  expect(object?.key).toBe("chat/a/1-2");
  expect([...(object?.bytes ?? [])]).toEqual([1, 2, 3]);
});

test("an empty key and empty bytes frame as two bytes", () => {
  const framed = frame("", bytes());
  expect(framed.length).toBe(2);
  expect(unframe(framed)).toEqual({ key: "", bytes: bytes() });
});

test("an object is read from where it starts in its buffer", () => {
  const framed = frame("k", bytes(9));
  const padded = new Uint8Array(framed.length + 3);
  padded.set(framed, 3);
  const object = unframe(padded.subarray(3));
  expect(object?.key).toBe("k");
  expect([...(object?.bytes ?? [])]).toEqual([9]);
});

test("bytes shorter than their key length are no object", () => {
  expect(unframe(bytes(0))).toBeUndefined();
  expect(unframe(frame("key", bytes()).subarray(0, 4))).toBeUndefined();
});

test("a key longer than 65535 bytes is refused", () => {
  expect(() => frame("k".repeat(65_536), bytes())).toThrow(RangeError);
});

test("tracks rank in the order the design lists, the chunk index with the catalog", () => {
  // The design's order, highest first; names on one line rank alike.
  const order = [
    ["control"],
    ["ctl", "deliver"],
    ["chat"],
    ["catalog", "index", "caps", "have"],
    ["init/0"],
    ["media/0", "media/1"],
    ["probe"],
  ];
  const ranks = order.map((names) => new Set(names.map(priority)));
  expect(ranks.map((rank) => rank.size)).toEqual(order.map(() => 1));
  const values = ranks.map((rank) => [...rank][0] ?? 0);
  expect(values).toEqual(values.toSorted((a, b) => b - a));
  expect(new Set(values).size).toBe(order.length);
});

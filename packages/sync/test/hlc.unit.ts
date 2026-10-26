// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The hybrid logical clock (src/hlc.ts), in Chromium: it never goes back, a received value moves it
// past that value, its counter carries into the wall clock, it survives a reload, and a value
// too far ahead is ignored.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { createClock, isHlc, MAX_AHEAD_MS } from "../src/hlc";

// A wall clock the test sets.
function wallClock(ms: number) {
  const clock = { ms, now: () => clock.ms };
  return clock;
}

test("a clock value is 16 hex digits: wall ms, then a counter", () => {
  const clock = createClock(() => 0x1234_5678_9abc);
  const value = clock.send();
  expect(value).toBe("123456789abc0000");
  expect(isHlc(value)).toBe(true);
});

test("sending moves the clock forward even when the wall clock stands still or goes back", () => {
  const wall = wallClock(1000);
  const clock = createClock(wall.now);
  const first = clock.send();
  const second = clock.send();
  wall.ms = 500;
  const third = clock.send();
  expect([first, second, third]).toEqual([
    "0000000003e80000",
    "0000000003e80001",
    "0000000003e80002",
  ]);
});

test("a reply sorts after the message it answers, even from a peer whose clock is behind", () => {
  const ahead = createClock(() => 50_000);
  const behind = createClock(() => 20_000);
  const message = ahead.send();
  behind.receive(message);
  const reply = behind.send();
  expect(reply > message).toBe(true);
});

test("receiving a value equal to the clock's wall time takes the larger counter, plus one", () => {
  const wall = wallClock(1000);
  const a = createClock(wall.now);
  const b = createClock(wall.now);
  a.send();
  a.send();
  const sent = a.send();
  b.send();
  b.receive(sent);
  expect(b.value()).toBe("0000000003e80003");
});

test("a counter past 16 bits carries into the wall clock", () => {
  const clock = createClock(() => 0, "000000000000ffff");
  expect(clock.send()).toBe("0000000000010000");
});

test("a wall clock past 48 bits of ms gives no clock value", () => {
  const clock = createClock(() => 2 ** 48);
  expect(() => clock.send()).toThrow(RangeError);
});

test("a clock created from a stored value never goes back after a reload", () => {
  const before = createClock(() => 9000);
  before.send();
  const stored = before.value();
  const after = createClock(() => 1000, stored);
  expect(after.send() > stored).toBe(true);
});

test("a received value too far ahead doesn't move the clock", () => {
  const clock = createClock(() => 1000);
  clock.send();
  const before = clock.value();
  const far = (1000 + MAX_AHEAD_MS + 1).toString(16).padStart(12, "0") + "0000";
  clock.receive(far);
  expect(clock.value()).toBe(before);
  const near = (1000 + MAX_AHEAD_MS).toString(16).padStart(12, "0") + "0000";
  clock.receive(near);
  expect(clock.value() > near).toBe(true);
});

test("anything but 16 lowercase hex digits is refused", () => {
  expect(isHlc("123456789ABC0000")).toBe(false);
  expect(isHlc("123")).toBe(false);
  expect(() => createClock(Date.now).receive("not a clock")).toThrow(RangeError);
});

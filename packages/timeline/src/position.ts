// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Position keys (docs/architecture.md#anchors): fractional indexes, strings that sort between
// their neighbours. A key is a head letter giving the integer part's length, base-62 digits, then
// a fraction with no trailing `0`. Appending or prepending steps the integer, so keys made one by
// one stay short; only inserting between two keys grows the fraction.
//
// Keys compare as strings by UTF-16 code unit (`<`), never by locale: the digits and head
// letters are ASCII, in the order their values have.

export type PositionKey = string;

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = "0";
const LAST = "z";
// The smallest integer part has no key before it, so it is never a key on its own.
const SMALLEST = `A${ZERO.repeat(26)}`;

function digit(char: string) {
  const value = DIGITS.indexOf(char);
  if (value < 0) throw new RangeError(`not a base-62 digit: ${char}`);
  return value;
}

// Heads `a`…`z` are integers of 1…26 digits upwards, `Z`…`A` of 1…26 digits downwards.
function integerLength(head: string) {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 96 + 1;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  throw new RangeError(`not a position key head: ${head}`);
}

function integerPart(key: PositionKey) {
  const length = integerLength(key.charAt(0));
  if (length > key.length) throw new RangeError(`position key too short: ${key}`);
  return key.slice(0, length);
}

export function isPositionKey(key: string) {
  try {
    validate(key);
    return true;
  } catch {
    return false;
  }
}

function validate(key: PositionKey) {
  if (key === SMALLEST) throw new RangeError(`not a position key: ${key}`);
  const integer = integerPart(key);

  for (const char of key.slice(1)) digit(char);
  if (key.length > integer.length && key.endsWith(ZERO))
    throw new RangeError(`position key ends in 0: ${key}`);
}

// A fraction strictly between fractions `a` and `b` (none: the end), neither ending in 0.
function midpoint(a: string, b: string | undefined): string {
  if (b !== undefined) {
    let n = 0;
    while ((a.charAt(n) || ZERO) === b.charAt(n)) n += 1;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }

  const low = a === "" ? 0 : digit(a.charAt(0));
  const high = b === undefined ? DIGITS.length : digit(b.charAt(0));
  if (high - low > 1) return DIGITS.charAt(Math.round((low + high) / 2));
  if (b !== undefined && b.length > 1) return b.charAt(0);
  return DIGITS.charAt(low) + midpoint(a.slice(1), undefined);
}

// The integer after `integer`, or undefined past the largest.
function increment(integer: string) {
  const head = integer.charAt(0);
  const digits = integer.slice(1).split("");

  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const value = digit(digits[i] ?? ZERO) + 1;

    if (value < DIGITS.length) {
      digits[i] = DIGITS.charAt(value);
      return head + digits.join("");
    }

    digits[i] = ZERO;
  }

  if (head === "Z") return `a${ZERO}`;
  if (head === "z") return undefined;
  const next = String.fromCharCode(head.charCodeAt(0) + 1);

  if (next > "a") digits.push(ZERO);
  else digits.pop();

  return next + digits.join("");
}

// The integer before `integer`, which isn't the smallest.
function decrement(integer: string) {
  const head = integer.charAt(0);
  const digits = integer.slice(1).split("");

  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const value = digit(digits[i] ?? ZERO) - 1;

    if (value >= 0) {
      digits[i] = DIGITS.charAt(value);
      return head + digits.join("");
    }

    digits[i] = LAST;
  }

  if (head === "a") return `Z${LAST}`;
  const next = String.fromCharCode(head.charCodeAt(0) - 1);

  if (next < "Z") digits.push(LAST);
  else digits.pop();

  return next + digits.join("");
}

/**
 * A key between `before` and `after`; leave either out for the start or the end. Throws unless
 * `before < after`. The same two keys always give the same key.
 */
export function keyBetween(before?: PositionKey, after?: PositionKey): PositionKey {
  if (before !== undefined) validate(before);
  if (after !== undefined) validate(after);

  if (before !== undefined && after !== undefined && before >= after) {
    throw new RangeError(`${before} is not before ${after}`);
  }

  if (before === undefined) return after === undefined ? `a${ZERO}` : keyBefore(after);
  if (after === undefined) return keyAfter(before);
  const low = integerPart(before);
  const high = integerPart(after);
  if (low === high) return low + midpoint(before.slice(low.length), after.slice(high.length));
  const next = increment(low);
  return next !== undefined && next < after
    ? next
    : low + midpoint(before.slice(low.length), undefined);
}

function keyBefore(after: PositionKey) {
  const integer = integerPart(after);
  const fraction = after.slice(integer.length);
  if (integer === SMALLEST) return integer + midpoint("", fraction);
  if (fraction !== "") return integer;
  const previous = decrement(integer);
  // The smallest integer isn't a key on its own; a fraction after it is, and still sorts first.
  return previous === SMALLEST ? previous + midpoint("", undefined) : previous;
}

function keyAfter(before: PositionKey) {
  const integer = integerPart(before);
  const next = increment(integer);
  return next ?? integer + midpoint(before.slice(integer.length), undefined);
}

/**
 * `count` consecutive keys between `before` and `after`, in order, for items inserted
 * together. Between two keys, they split the gap evenly, so none of them grows longer than it
 * must.
 */
export function keysBetween(
  before: PositionKey | undefined,
  after: PositionKey | undefined,
  count: number,
): PositionKey[] {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`not a key count: ${count}`);
  if (count === 0) return [];
  if (count === 1) return [keyBetween(before, after)];

  if (after === undefined) {
    const keys = [keyBetween(before, after)];
    while (keys.length < count) keys.push(keyBetween(keys.at(-1), undefined));
    return keys;
  }

  if (before === undefined) {
    const keys = [keyBetween(before, after)];
    while (keys.length < count) keys.unshift(keyBetween(undefined, keys[0]));
    return keys;
  }

  const half = Math.floor(count / 2);
  const middle = keyBetween(before, after);
  return [
    ...keysBetween(before, middle, half),
    middle,
    ...keysBetween(middle, after, count - half - 1),
  ];
}

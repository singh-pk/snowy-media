// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Schemas for canonical JSON (docs/architecture.md#batches): a checked value comes back with its
// fields in schema order, absent ones left out, and an open record's keys in code-point order, so
// `JSON.stringify` of it is the canonical bytes, and re-encoding gives back only canonical bytes.

/** Thrown for a value that doesn't fit its schema. */
export class InvalidError extends Error {
  constructor(at: string, reason: string) {
    super(`${at === "" ? "value" : at}: ${reason}`);
    this.name = "InvalidError";
  }
}

/** Checks a value found at path `at`, returning it in canonical shape. */
export type Schema<T> = (value: unknown, at: string) => T;
type Optional<T> = Schema<T> & { readonly optional: true };
type Field = Schema<unknown> | Optional<unknown>;
type Infer<S> = S extends Schema<infer T> ? T : never;
type Fields = Record<string, Field>;
type Shape<F extends Fields> = {
  [K in keyof F as F[K] extends Optional<unknown> ? never : K]: Infer<F[K]>;
} & {
  [K in keyof F as F[K] extends Optional<unknown> ? K : never]?: Infer<F[K]>;
};
type Flat<T> = { [K in keyof T]: T[K] } & {};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A field that may be absent. Present, it is checked by `schema`. */
export function optional<T>(schema: Schema<T>): Optional<T> {
  return Object.assign((value: unknown, at: string) => schema(value, at), {
    optional: true as const,
  });
}

/** A string, matching `pattern` if one is given, of at most `max` UTF-16 code units. */
export function string(pattern?: RegExp, max = Number.POSITIVE_INFINITY): Schema<string> {
  return (value, at) => {
    if (typeof value !== "string") throw new InvalidError(at, "not a string");
    if (value.length > max) throw new InvalidError(at, `longer than ${max}`);

    if (pattern !== undefined && !pattern.test(value)) {
      throw new InvalidError(at, `doesn't match ${pattern}`);
    }

    return value;
  };
}

export function oneOf<const T extends string>(...values: T[]): Schema<T> {
  return (value, at) => {
    const found = values.find((v) => v === value);
    if (found === undefined) throw new InvalidError(at, `not one of ${values.join(", ")}`);
    return found;
  };
}

/** A safe integer from `min` to `max`. */
export function integer(
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
): Schema<number> {
  return (value, at) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new InvalidError(at, "not an integer");
    }

    if (value < min || value > max) throw new InvalidError(at, `not from ${min} to ${max}`);
    return value;
  };
}

/** A finite number: JSON has no infinities or NaN. -0 becomes 0, which is how JSON spells it. */
export const finite: Schema<number> = (value, at) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidError(at, "not a finite number");
  }

  return value === 0 ? 0 : value;
};

export const boolean: Schema<boolean> = (value, at) => {
  if (typeof value !== "boolean") throw new InvalidError(at, "not a boolean");
  return value;
};

export function literal<const T extends string>(expected: T): Schema<T> {
  return (value, at) => {
    if (value !== expected) throw new InvalidError(at, `not ${expected}`);
    return expected;
  };
}

/** An array of `min` to `max` elements, each checked by `element`. */
export function array<T>(element: Schema<T>, min = 0, max = Number.POSITIVE_INFINITY): Schema<T[]> {
  return (value, at) => {
    if (!Array.isArray(value)) throw new InvalidError(at, "not an array");

    if (value.length < min || value.length > max) {
      throw new InvalidError(at, `not ${min} to ${max} elements`);
    }

    return value.map((item: unknown, i) => element(item, `${at}[${i}]`));
  };
}

/** A fixed list `[a, b]`, such as a ratio. */
export function pair<A, B>(first: Schema<A>, second: Schema<B>): Schema<[A, B]> {
  return (value, at) => {
    if (!Array.isArray(value) || value.length !== 2) throw new InvalidError(at, "not a pair");
    return [first(value[0], `${at}[0]`), second(value[1], `${at}[1]`)];
  };
}

// The combinators below build values whose type TypeScript can't follow (a record's fields, a
// union's variants), so each declares the type it returns in an overload signature: the checks
// in its body are what make that type true.

/**
 * A record with exactly the fields `fields` declares, in that order. A field of another name is
 * refused; an optional one may be absent.
 */
export function record<F extends Fields>(fields: F): Schema<Flat<Shape<F>>>;

export function record(fields: Fields): Schema<Record<string, unknown>> {
  const names = new Set(Object.keys(fields));
  return (value, at) => {
    if (!isRecord(value)) throw new InvalidError(at, "not an object");
    const unknown = Object.keys(value).find((key) => !names.has(key));
    if (unknown !== undefined) throw new InvalidError(at, `unknown field ${unknown}`);
    const checked: Record<string, unknown> = {};

    for (const [name, field] of Object.entries(fields)) {
      if (value[name] === undefined && "optional" in field) continue;
      checked[name] = field(value[name], at === "" ? name : `${at}.${name}`);
    }

    return checked;
  };
}

// a − b by Unicode code point, which differs from `<` (UTF-16 code units) past U+FFFF.
function byCodePoint(a: string, b: string) {
  let i = 0;

  // Equal so far, so both strings are at the same index `i`.
  while (i < a.length && i < b.length) {
    const left = a.codePointAt(i) ?? 0;
    const right = b.codePointAt(i) ?? 0;
    if (left !== right) return left - right;
    i += left > 0xffff ? 2 : 1;
  }

  return a.length - b.length;
}

/**
 * An open record of at most `max` keys, each matching `key`, returned in code-point order, with
 * each value checked by `value`.
 */
export function map<T>(
  key: RegExp,
  value: Schema<T>,
  max = Number.POSITIVE_INFINITY,
): Schema<Record<string, T>> {
  return (input, at) => {
    if (!isRecord(input)) throw new InvalidError(at, "not an object");
    const keys = Object.keys(input).toSorted(byCodePoint);
    if (keys.length > max) throw new InvalidError(at, `more than ${max} keys`);
    const checked: Record<string, T> = {};

    for (const name of keys) {
      if (!key.test(name)) throw new InvalidError(at, `bad key ${name}`);
      checked[name] = value(input[name], `${at}.${name}`);
    }

    return checked;
  };
}

/** One of several records, told apart by the string in field `tag`. */
export function union<V extends Record<string, Schema<unknown>>>(
  tag: string,
  variants: V,
): Schema<Infer<V[keyof V]>>;

export function union(tag: string, variants: Record<string, Schema<unknown>>): Schema<unknown> {
  return (value, at) => {
    if (!isRecord(value)) throw new InvalidError(at, "not an object");
    const name = value[tag];
    const variant =
      typeof name === "string" && Object.hasOwn(variants, name) ? variants[name] : undefined;
    if (variant === undefined) throw new InvalidError(at === "" ? tag : `${at}.${tag}`, "unknown");
    return variant(value, at);
  };
}

/** The first of `options` that accepts the value, for shapes no one field tells apart. */
export function either<S extends Array<Schema<unknown>>>(
  options: [...S],
  reason: string,
): Schema<Infer<S[number]>>;

export function either(options: Array<Schema<unknown>>, reason: string): Schema<unknown> {
  return (value, at) => {
    for (const option of options) {
      try {
        return option(value, at);
      } catch (error) {
        if (!(error instanceof InvalidError)) throw error;
      }
    }

    throw new InvalidError(at, reason);
  };
}

/** What `schema` accepts, if `test` also holds for it. */
export function refine<T>(
  schema: Schema<T>,
  test: (value: T) => boolean,
  reason: string,
): Schema<T> {
  return (value, at) => {
    const checked = schema(value, at);
    if (!test(checked)) throw new InvalidError(at, reason);
    return checked;
  };
}

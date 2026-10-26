// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The leaves of a record (docs/architecture.md#operation-kinds): which paths `*.set` may change, a
// clip's absent video and audio read as their defaults, and a record with one leaf set, to check
// against its schema again.

import type { Value } from "./document";
import { skip } from "./skip";

// What a clip's absent video or audio fields are, so setting one leaf of them fills the rest.
const DEFAULTS: Record<string, Value | Record<string, unknown>> = {
  video: {
    opacity: 1,
    blend: "normal",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  },
  audio: { gainDb: 0, pan: 0, fadeIn: 0, fadeOut: 0 },
};

// The first segment of each path `*.set` may change; the rest are structural, changed by their
// own operations or never.
const SETTABLE: Record<string, ReadonlySet<string>> = {
  sequence: new Set(["name", "rate", "width", "height", "sampleRate"]),
  role: new Set(["name", "color", "order"]),
  clip: new Set(["in", "duration", "speed", "role", "lane", "enabled", "name", "video", "audio"]),
  gap: new Set(["duration"]),
  transition: new Set(["duration", "effect", "params"]),
  marker: new Set(["duration", "type", "name", "note", "done"]),
  effect: new Set(["position", "enabled", "params"]),
};

/**
 * The fields of a clip a keyframe may animate: its picture, its sound and its generator's
 * parameters, never its timing or its place.
 */
export const ANIMATED = /^(video|audio|source\.params)\./;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `record` with the leaf at `path` set to `value`, as a new object to check against its schema.
 * A clip's generator parameters are reached as `source.params.<name>`.
 */
export function withLeaf(record: object, kind: string, path: string, value: Value) {
  const segments = path.split(".");
  const [root = ""] = segments;
  const generatorParam =
    kind === "clip" && segments.length === 3 && path.startsWith("source.params.");
  if (!SETTABLE[kind]?.has(root) && !generatorParam) skip("malformed", `${path} can't be set`);
  const copy: Record<string, unknown> = structuredClone({ ...record });
  let node = copy;

  for (const [i, segment] of segments.slice(0, -1).entries()) {
    const next = node[segment] ?? (i === 0 ? structuredClone(DEFAULTS[segment]) : undefined);
    if (!isObject(next)) skip("malformed", `${path} isn't a field`);
    node[segment] = next;
    node = next;
  }

  node[segments.at(-1) ?? ""] = value;
  return copy;
}

/**
 * The leaf at `path` of a record, reading an absent `video` or `audio` as its defaults, as
 * setting one of its leaves fills them in; undefined for a leaf the record doesn't have.
 */
export function leafOf(record: object, path: string): Value | undefined {
  const [root = "", ...rest] = path.split(".");
  let node: unknown = isObject(record) ? (record[root] ?? DEFAULTS[root]) : undefined;

  for (const segment of rest) {
    if (!isObject(node)) return undefined;
    node = node[segment];
  }

  return isValue(node) ? node : undefined;
}

function isValue(value: unknown): value is Value {
  const type = typeof value;
  if (type === "boolean" || type === "number" || type === "string") return true;
  return Array.isArray(value) && value.every(isValue);
}

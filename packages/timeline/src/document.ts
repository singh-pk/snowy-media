// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The document's records and operations as schemas (docs/architecture.md#the-document,
// #operation-kinds; src/schema.ts). A record an operation adds has no id in the operation; its id
// is the operation's, `<author>.<seq>.<index>` (src/ids.ts).

import { ITEM_ID, KEY_ID } from "./ids";
import { isPositionKey } from "./position";
import {
  array,
  boolean,
  either,
  finite,
  InvalidError,
  integer,
  literal,
  map,
  oneOf,
  optional,
  pair,
  record,
  refine,
  string,
  union,
  type Schema,
} from "./schema";

/** The value of a parameter or a leaf: a boolean, a finite number, a string, or a list of them. */
export type Value = boolean | number | string | Value[];

/** A SHA-256 hash: 32 bytes as unpadded base64url, in their one spelling, like a key id. */
const HASH = KEY_ID;
const NAME = 256;
const TEXT = 65_536;
const LIST = 4096;

export const keyId = string(KEY_ID);
const itemId = string(ITEM_ID);
export const hash = string(HASH);
const assetId = hash;
export const branchId = either([literal("main"), itemId], "not main or an item id");
const position = refine(string(undefined, NAME), isPositionKey, "not a position key");
const name = string(undefined, NAME);
// A field path down to a leaf, such as `video.transform.x` (docs/architecture.md#items).
const path = string(/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/, NAME);
// A parameter's or a generator's name, such as `amount` or `fontSize`.
const PARAM = /^[a-z][A-Za-z0-9]*$/;
const count = integer(0);
const flicks = integer();
const duration = integer(0);
// A positive fraction: a rate or a time base.
const ratio = pair(integer(1), integer(1));
const speed = refine(pair(integer(), integer(1)), ([num]) => num !== 0, "a speed of zero");

// Lists nest at most this deep, so checking a value can't run out of stack on hostile bytes.
const DEPTH = 8;

function valueAt(depth: number): Schema<Value> {
  return (input, at) => {
    if (typeof input === "boolean") return input;
    if (typeof input === "number") return finite(input, at);
    if (typeof input === "string") return string(undefined, TEXT)(input, at);
    if (depth === DEPTH) throw new InvalidError(at, `lists nested deeper than ${DEPTH}`);
    return array(valueAt(depth + 1), 0, LIST)(input, at);
  };
}

export const value = valueAt(0);

const params = map(PARAM, value, LIST);

const stream = record({
  index: count,
  kind: oneOf("video", "audio", "subtitle"),
  timeBase: ratio,
  start: flicks,
  duration,
  rate: optional(ratio),
  width: optional(integer(1)),
  height: optional(integer(1)),
  sampleRate: optional(integer(1)),
  channels: optional(integer(1)),
});

const asset = record({
  id: assetId,
  size: count,
  head: hash,
  tail: hash,
  name,
  streams: array(stream, 0, LIST),
  path: optional(string(undefined, TEXT)),
});

export const sequence = record({
  name,
  rate: ratio,
  width: integer(1),
  height: integer(1),
  sampleRate: integer(1),
});

export const role = record({
  sequence: itemId,
  name,
  kind: oneOf("video", "audio"),
  color: string(/^#[0-9a-f]{6}$/),
  order: position,
});

export const anchor = either(
  [
    record({ storyline: itemId, position }),
    record({ clip: itemId, at: flicks }),
    record({ origin: itemId, at: flicks }),
  ],
  "not a storyline, clip or origin anchor",
);

const source = either(
  [
    record({ asset: assetId, stream: count }),
    record({ generator: string(PARAM, NAME), params }),
    record({ sequence: itemId }),
  ],
  "not an asset, generator or sequence source",
);

const blend = oneOf(
  "normal",
  "add",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "difference",
);

const transform = record({
  x: finite,
  y: finite,
  scaleX: finite,
  scaleY: finite,
  rotation: finite,
});

export const item = union("kind", {
  clip: record({
    kind: literal("clip"),
    source,
    in: flicks,
    duration,
    speed,
    anchor,
    role: itemId,
    lane: count,
    enabled: boolean,
    name: optional(name),
    video: optional(record({ opacity: finite, blend, transform })),
    audio: optional(record({ gainDb: finite, pan: finite, fadeIn: duration, fadeOut: duration })),
  }),
  gap: record({ kind: literal("gap"), anchor, duration }),
  transition: record({
    kind: literal("transition"),
    cut: itemId,
    duration,
    effect: string(/^[a-z][a-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/, NAME),
    params,
  }),
  marker: record({
    kind: literal("marker"),
    anchor,
    duration,
    type: oneOf("marker", "chapter", "todo"),
    name,
    note: optional(string(undefined, TEXT)),
    done: optional(boolean),
  }),
});

export const effect = record({
  clip: itemId,
  kind: string(/^[a-z][a-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/, NAME),
  position,
  enabled: boolean,
  params,
});

// A bezier is its two control points, `[x1, y1, x2, y2]`, as in CSS `cubic-bezier()`.
const ease = either(
  [oneOf("hold", "linear"), record({ bezier: array(finite, 4, 4) })],
  "not hold, linear or a bezier",
);

const keyframe = record({ target: itemId, param: path, at: flicks, value, ease });

/** A history entry by number and hash: `{ n: 0, hash: "" }` is a branch before its first entry. */
export const entryRef = refine(
  record({ n: count, hash: either([literal(""), hash], "not a hash") }),
  (ref) => (ref.n === 0) === (ref.hash === ""),
  "only entry 0 has no hash",
);

const set = <K extends string>(op: K) => record({ op: literal(op), id: itemId, path, value });
const remove = <K extends string>(op: K) => record({ op: literal(op), id: itemId });

export const operation = union("op", {
  "project.set": record({ op: literal("project.set"), name }),
  "asset.add": record({ op: literal("asset.add"), asset }),
  "asset.remove": record({ op: literal("asset.remove"), id: assetId }),
  "sequence.add": record({ op: literal("sequence.add"), sequence }),
  "sequence.set": set("sequence.set"),
  "sequence.remove": remove("sequence.remove"),
  "role.add": record({ op: literal("role.add"), role }),
  "role.set": set("role.set"),
  "role.remove": remove("role.remove"),
  "item.add": record({ op: literal("item.add"), item }),
  "item.set": set("item.set"),
  "item.move": record({ op: literal("item.move"), id: itemId, anchor }),
  "item.remove": remove("item.remove"),
  "item.restore": remove("item.restore"),
  "clip.split": record({ op: literal("clip.split"), id: itemId, at: flicks }),
  "clip.join": record({ op: literal("clip.join"), id: itemId, next: itemId }),
  "effect.add": record({ op: literal("effect.add"), effect }),
  "effect.set": set("effect.set"),
  "effect.remove": remove("effect.remove"),
  "keyframe.set": record({ op: literal("keyframe.set"), keyframe }),
  "keyframe.remove": record({
    op: literal("keyframe.remove"),
    target: itemId,
    param: path,
    at: flicks,
  }),
  revert: record({ op: literal("revert"), to: entryRef }),
  "branch.create": record({ op: literal("branch.create"), name }),
  "branch.merge": either(
    [
      record({ op: literal("branch.merge"), branch: branchId, through: entryRef }),
      record({ op: literal("branch.merge"), branch: branchId, entries: array(entryRef, 1, LIST) }),
    ],
    "a merge names everything through an entry, or chosen entries",
  ),
  "branch.close": record({ op: literal("branch.close"), branch: branchId }),
});

export type Asset = ReturnType<typeof asset>;
/** A sequence's settings, without its id. */
export type SequenceRecord = ReturnType<typeof sequence>;
/** A role, without its id. */
export type RoleRecord = ReturnType<typeof role>;
/** A clip, gap, transition or marker, without its id. */
export type ItemRecord = ReturnType<typeof item>;
/** An effect, without its id. */
export type EffectRecord = ReturnType<typeof effect>;
/** A keyframe, known by its target, param and source point. */
export type KeyframeRecord = ReturnType<typeof keyframe>;
export type Anchor = ReturnType<typeof anchor>;

export type EntryRef = ReturnType<typeof entryRef>;

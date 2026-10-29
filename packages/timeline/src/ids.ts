// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Item ids (docs/architecture.md#ids): `<author>.<seq>.<index>`, the batch that made the item
// and the operation's place in it, so ids are unique without a counter or a coordinator. An
// author is a key id in unpadded base64url, which has no `.`, so the id splits back unambiguously
// and is safe in a file or track name.

/** A peer key's id: its 32 raw bytes as unpadded base64url, as `@snowy-media/sync` writes it. */
export type KeyId = string;

/** The id of an item: `<author>.<seq>.<index>`. */
export type ItemId = string;

/**
 * A key id. 32 bytes are 43 base64url characters, and the last carries 4 bits and 2 zero bits, so
 * only these 16 characters may end one and each key has a single spelling.
 */
export const KEY_ID = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
/**
 * An item id: `seq` from 1 and `index` from 0, in decimal without leading zeros, so each id has
 * one spelling.
 */
export const ITEM_ID = /^([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])\.([1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function isKeyId(value: string) {
  return KEY_ID.test(value);
}

/** The id of the item made by operation `index` of batch `seq` by `author`. */
export function itemId(author: KeyId, seq: number, index: number): ItemId {
  if (!isKeyId(author)) throw new RangeError(`not a key id: ${author}`);
  if (!Number.isSafeInteger(seq) || seq < 1) throw new RangeError(`not a batch seq: ${seq}`);
  if (!Number.isSafeInteger(index) || index < 0)
    throw new RangeError(`not an operation index: ${index}`);
  return `${author}.${seq}.${index}`;
}

/** The batch and operation an item id names, or undefined for anything that isn't one. */
export function parseItemId(id: string) {
  const match = ITEM_ID.exec(id);
  if (match === null) return undefined;
  const [, author = "", seq = "", index = ""] = match;
  const parts = { author, seq: Number(seq), index: Number(index) };
  return Number.isSafeInteger(parts.seq) && Number.isSafeInteger(parts.index) ? parts : undefined;
}

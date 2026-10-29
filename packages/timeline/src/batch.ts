// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Batches (docs/architecture.md#batches): one gesture's operations, signed by their author, in
// canonical bytes (src/signed.ts) under the domain `snowy batch v1\n`.

import { branchId, entryRef, hash, keyId, operation } from "./document";
import type { KeyId } from "./ids";
import { either, array, integer, literal, optional, record, refine, string } from "./schema";
import { base64url, MAX_SIGNED_BYTES, signature, signedFormat } from "./signed";

/** The largest batch, in canonical bytes. */
export const MAX_BATCH_BYTES = MAX_SIGNED_BYTES;

const fields = {
  author: keyId,
  seq: integer(1),
  prev: either([literal(""), hash], "not a hash"),
  branch: branchId,
  branchPrev: integer(0),
  base: entryRef,
  hlc: string(/^[0-9a-f]{16}$/),
  label: string(undefined, 256),
  undoes: optional(record({ author: keyId, seq: integer(1) })),
  ops: array(operation, 1),
};

// Rules that span fields, which no single field's schema can check.
function chained(batch: { seq: number; prev: string; branchPrev: number }) {
  return (batch.seq === 1) === (batch.prev === "") && batch.branchPrev < batch.seq;
}

const unsignedBatch = refine(record(fields), chained, "prev or branchPrev doesn't fit seq");
const signedBatch = refine(
  record({ ...fields, sig: signature }),
  chained,
  "prev or branchPrev doesn't fit seq",
);

/** A signed batch, in canonical shape. */
export type Batch = ReturnType<typeof signedBatch>;
export type UnsignedBatch = ReturnType<typeof unsignedBatch>;

const format = signedFormat<Batch>({
  noun: "a batch",
  domain: "snowy batch v1\n",
  unsigned: unsignedBatch,
  signed: signedBatch,
});

/** Checks an untrusted batch, returning it in canonical shape. Throws an `InvalidError`. */
export const checkBatch = format.check;

/** A batch's canonical bytes. Throws an `InvalidError` for a malformed or oversized batch. */
export const encodeBatch = format.encode;

/**
 * Reads a batch's bytes, refusing any that aren't its canonical bytes. Throws an `InvalidError`.
 */
export const decodeBatch = format.decode;

/** The id of a peer's public key, as `author` names it. */
export async function keyIdOf(publicKey: CryptoKey): Promise<KeyId> {
  const raw = await crypto.subtle.exportKey("raw", publicKey);
  return base64url(raw);
}

/** Signs a batch with its author's peer key. Throws if the key isn't the author's. */
export async function signBatch(peer: CryptoKeyPair, batch: UnsignedBatch): Promise<Batch> {
  const author = await keyIdOf(peer.publicKey);
  if (author !== batch.author) throw new RangeError("a batch is signed by its author");
  return format.sign(peer.privateKey, batch);
}

/** Whether a batch's signature is its author's. */
export const verifyBatch = (batch: Batch) => format.verify(batch, batch.author);

/** The SHA-256 of a batch's canonical bytes, signature included, as unpadded base64url. */
export const batchHash = format.hash;

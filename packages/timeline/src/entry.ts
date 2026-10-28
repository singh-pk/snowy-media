// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Entries and refusals (docs/architecture.md#entries): a sequencer's record that it appended a
// batch to a branch's history, or refused it. Both are signed by the sequencer's peer key, in
// canonical bytes (src/signed.ts), each under its own domain.

import { branchId, hash, keyId } from "./document";
import { either, integer, literal, oneOf, record, refine } from "./schema";
import { signature, signedFormat } from "./signed";

const batchRef = record({ author: keyId, seq: integer(1), hash });

const entryFields = {
  branch: branchId,
  n: integer(1),
  term: integer(1),
  prev: either([literal(""), hash], "not a hash"),
  batch: batchRef,
};

const chained = (entry: { n: number; prev: string }) => (entry.n === 1) === (entry.prev === "");

const unsignedEntry = refine(record(entryFields), chained, "prev doesn't fit n");
const signedEntry = refine(
  record({ ...entryFields, sig: signature }),
  chained,
  "prev doesn't fit n",
);

/** A batch appended to a branch's history, signed by its sequencer. */
export type Entry = ReturnType<typeof signedEntry>;

const refusalFields = {
  branch: branchId,
  batch: batchRef,
  reason: oneOf("signature", "chain", "rights", "format"),
  term: integer(1),
};

const unsignedRefusal = record(refusalFields);
const signedRefusal = record({ ...refusalFields, sig: signature });

/** A batch a sequencer refused, which settles its seq on the branch. */
export type Refusal = ReturnType<typeof signedRefusal>;

/** Entries' bytes, signatures and hashes, as `prev` and an `EntryRef` name them. */
export const entries = signedFormat<Entry>({
  noun: "an entry",
  domain: "snowy entry v1\n",
  unsigned: unsignedEntry,
  signed: signedEntry,
});

export const refusals = signedFormat<Refusal>({
  noun: "a refusal",
  domain: "snowy refusal v1\n",
  unsigned: unsignedRefusal,
  signed: signedRefusal,
});

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The source's signed records (docs/architecture.md#catalog): JSON signed by the session key
// over a domain prefix, the session and every field in a fixed order. The prefix keeps a
// signature over one kind of record from passing for another, or for anything else the session
// key signs. Each kind checks its own fields into canonical shape; this signs and verifies that.

import { isRecord } from "./chat";
import { keyId, sigBytes, sign, verify, type Bytes, type KeyId } from "./crypto";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Thrown for a record that doesn't parse, isn't the one its key names, or isn't signed. */
export class InvalidRecordError extends Error {
  constructor(reason: string) {
    super(`Invalid source record: ${reason}`);
    this.name = "InvalidRecordError";
  }
}

export const base64 = (bytes: Bytes) =>
  bytes.toBase64({ alphabet: "base64url", omitPadding: true });

/** Refuses a field not in `fields`, so a record carries nothing unsigned. */
export function onlyFields(value: Record<string, unknown>, fields: Set<string>) {
  const unknown = Object.keys(value).find((k) => !fields.has(k));
  if (unknown !== undefined) throw new InvalidRecordError(`unknown field ${unknown}`);
}

// copy: once per record signed or checked, with its session.
const signedBytes = (domain: string, session: KeyId, record: object) =>
  encoder.encode(`${domain}\n${JSON.stringify({ session, ...record })}`);

/** A record in canonical shape, signed with the session key under `domain`, as bytes. */
export async function signRecord(session: CryptoKeyPair, domain: string, record: object) {
  const id = await keyId(session.publicKey);
  const sig = await sign(session.privateKey, signedBytes(domain, id, record));
  // copy: once per record signed, with its signature.
  return encoder.encode(JSON.stringify({ ...record, sig: base64(sig) }));
}

// The JSON in `bytes`, or an `InvalidRecordError` for anything that isn't UTF-8 JSON.
function parseJson(bytes: Bytes): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new InvalidRecordError("not UTF-8 JSON");
  }
}

/** The record in `bytes`, split into its signature and the rest, or an `InvalidRecordError`. */
export function parseRecord(bytes: Bytes) {
  const value = parseJson(bytes);
  if (!isRecord(value)) throw new InvalidRecordError("not an object");
  const { sig, ...fields } = value;
  return { sig, fields };
}

/**
 * Checks that `sig` is the session key's signature under `domain` of the record, in canonical
 * shape. Rejects with an `InvalidRecordError` if it isn't.
 */
export async function checkRecordSig(
  sessionKey: CryptoKey,
  domain: string,
  sig: unknown,
  record: object,
) {
  const bytes = sigBytes(sig);
  if (bytes === undefined) throw new InvalidRecordError("bad sig");
  const session = await keyId(sessionKey);
  const valid = await verify(sessionKey, bytes, signedBytes(domain, session, record));
  if (!valid) throw new InvalidRecordError("bad signature");
}

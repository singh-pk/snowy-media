// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// What the tests of the source's signed records share: a session key pair, a record's JSON, and
// a record changed and signed again, to reach a check that a bad signature would hide.

import { generateKeyPair, keyId, sign, type Bytes } from "../../src/crypto";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const json = (bytes: Bytes): Record<string, unknown> => JSON.parse(decoder.decode(bytes));

export async function createRecordSigner() {
  const pair = await generateKeyPair();
  const session = await keyId(pair.publicKey);

  // A record's JSON with `change` made, signed again by the session key as `domain` gives it.
  async function resigned(
    bytes: Bytes,
    domain: string,
    change: (record: Record<string, unknown>) => void,
  ) {
    const { sig: _, ...record } = json(bytes);
    change(record);
    const signed = encoder.encode(`${domain}\n${JSON.stringify({ session, ...record })}`);
    const sig = await sign(pair.privateKey, signed);
    const base64 = sig.toBase64({ alphabet: "base64url", omitPadding: true });
    return encoder.encode(JSON.stringify({ ...record, sig: base64 }));
  }

  return { pair, resigned };
}

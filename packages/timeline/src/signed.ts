// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Signed objects (docs/architecture.md#batches): canonical JSON, at most 1 MiB, refused unless it
// re-encodes to its bytes, so every peer hashes and verifies the same bytes. A signature covers a
// domain naming the kind, then the bytes without `sig`: it can't pass for anything else a key signs.

import type { KeyId } from "./ids";
import { InvalidError, string, type Schema } from "./schema";

/** The largest signed object, in canonical bytes. */
export const MAX_SIGNED_BYTES = 1 << 20;

/** An Ed25519 signature: 64 bytes as unpadded base64url, in their one spelling. */
export const signature = string(/^[A-Za-z0-9_-]{85}[AQgw]$/);

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

// The JSON in `bytes`, or an `InvalidError` for anything that isn't UTF-8 JSON.
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new InvalidError("", "not UTF-8 JSON");
  }
}

export const base64url = (bytes: ArrayBuffer) =>
  new Uint8Array(bytes).toBase64({ alphabet: "base64url", omitPadding: true });

/** How one kind of signed object is checked, encoded, signed, verified and hashed. */
export function signedFormat<S extends { sig: string }>(options: {
  noun: string;
  domain: string;
  unsigned: Schema<Omit<S, "sig">>;
  signed: Schema<S>;
}) {
  const { noun, unsigned, signed } = options;
  const domain = encoder.encode(options.domain);

  function bytesOf(value: unknown) {
    const bytes = encoder.encode(JSON.stringify(value));
    if (bytes.byteLength > MAX_SIGNED_BYTES) throw new InvalidError("", `${noun} over 1 MiB`);
    return bytes;
  }

  /** Checks an untrusted object, returning it in canonical shape. Throws an `InvalidError`. */
  const check = (value: unknown): S => signed(value, "");

  /** An object's canonical bytes. Throws an `InvalidError` for a malformed or oversized one. */
  const encode = (value: S) => bytesOf(check(value));

  /** Reads an object's bytes, refusing any that aren't its canonical bytes. */
  function decode(bytes: Uint8Array): S {
    if (bytes.byteLength > MAX_SIGNED_BYTES) throw new InvalidError("", `${noun} over 1 MiB`);
    const value = check(parseJson(bytes));
    const canonical = bytesOf(value);
    const same =
      canonical.byteLength === bytes.byteLength && canonical.every((b, i) => b === bytes[i]);
    if (!same) throw new InvalidError("", "not in canonical form");
    return value;
  }

  // What the signature covers: the domain, then the canonical bytes without `sig`.
  function signedBytes(value: unknown) {
    const body = bytesOf(unsigned(value, ""));
    const bytes = new Uint8Array(domain.byteLength + body.byteLength);
    bytes.set(domain);
    bytes.set(body, domain.byteLength);
    return bytes;
  }

  async function sign(privateKey: CryptoKey, value: Omit<S, "sig">): Promise<S> {
    const sig = await crypto.subtle.sign("Ed25519", privateKey, signedBytes(value));
    const result = check({ ...value, sig: base64url(sig) });
    // The signature adds bytes, which can take an object just under the limit over it.
    bytesOf(result);
    return result;
  }

  /** Whether an object's signature is the given key's. */
  async function verify(value: S, signer: KeyId) {
    const { sig, ...rest } = value;
    const raw = Uint8Array.fromBase64(signer, { alphabet: "base64url" });
    const publicKey = await crypto.subtle.importKey("raw", raw, "Ed25519", false, ["verify"]);
    const sigBytes = Uint8Array.fromBase64(sig, { alphabet: "base64url" });
    return crypto.subtle.verify("Ed25519", publicKey, sigBytes, signedBytes(rest));
  }

  /** The SHA-256 of an object's canonical bytes, signature included, as unpadded base64url. */
  async function hash(value: S) {
    const digest = await crypto.subtle.digest("SHA-256", encode(value));
    return base64url(digest);
  }

  return { check, encode, decode, sign, verify, hash };
}

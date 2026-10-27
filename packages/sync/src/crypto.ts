// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Keys, signatures and encryption for every object (docs/architecture.md#identity-sessions-and-access,
// docs/architecture.md#encryption). Peers and the session are Ed25519 public keys, named by
// their base64url; content is AES-256-GCM under a key derived from the session secret, with a
// fresh random nonce for every encryption, so no object key, replaced object or lost counter
// can ever reuse one.

const NONCE = 12;
const KEY = 32;
// An Ed25519 signature, as unpadded base64url.
const SIG = /^[A-Za-z0-9_-]{86}$/;
const encoder = new TextEncoder();

/** Bytes WebCrypto accepts: never a view of a SharedArrayBuffer. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** An object as it travels: its key, and its bytes sealed under that key. */
export type SealedObject = { key: string; sealed: Bytes };

/** An Ed25519 public key, as unpadded base64url: a `PeerId` or a `SessionId`. */
export type KeyId = string;

/** A new Ed25519 key pair. The private key is non-extractable; the public key always is. */
export function generateKeyPair() {
  return crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
}

/** The id of a public key: its 32 raw bytes as unpadded base64url. */
export async function keyId(publicKey: CryptoKey): Promise<KeyId> {
  const raw = await crypto.subtle.exportKey("raw", publicKey);
  return new Uint8Array(raw).toBase64({ alphabet: "base64url", omitPadding: true });
}

/** The raw 32 bytes of a key id. Throws for anything that isn't one. */
export function keyBytes(id: KeyId): Bytes {
  const bytes = new Uint8Array(Uint8Array.fromBase64(id, { alphabet: "base64url" }));
  if (bytes.byteLength !== KEY) throw new RangeError(`not a key id: ${id}`);
  return bytes;
}

/**
 * Whether a value is a key id in its one spelling: base64url can spell some keys two ways, which
 * would give one author two logs.
 */
export function isKeyId(value: unknown): value is KeyId {
  if (typeof value !== "string") return false;

  try {
    return keyBytes(value).toBase64({ alphabet: "base64url", omitPadding: true }) === value;
  } catch {
    return false;
  }
}

/**
 * The bytes of a signature in its one spelling, or undefined: like a key id, base64url can spell
 * some signatures more than one way.
 */
export function sigBytes(sig: unknown) {
  if (typeof sig !== "string" || !SIG.test(sig)) return undefined;

  const bytes = new Uint8Array(Uint8Array.fromBase64(sig, { alphabet: "base64url" }));
  const canonical = bytes.toBase64({ alphabet: "base64url", omitPadding: true }) === sig;
  return canonical ? bytes : undefined;
}

/** The public key a key id names, for verifying. */
export const publicKey = (id: KeyId) =>
  crypto.subtle.importKey("raw", keyBytes(id), { name: "Ed25519" }, true, ["verify"]);

/** Bytes as unpadded base64url, the one spelling of key ids and signatures. */
export const base64url = (bytes: Bytes) =>
  bytes.toBase64({ alphabet: "base64url", omitPadding: true });

/** Whether `sig`, in its one spelling, is the signature by the key `key` names of `data`. */
export async function signedBy(key: KeyId, sig: unknown, data: Bytes) {
  const bytes = sigBytes(sig);
  if (bytes === undefined) return false;
  const imported = await publicKey(key);
  return verify(imported, bytes, data);
}

export async function sign(privateKey: CryptoKey, data: Bytes) {
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, data);
  return new Uint8Array(sig);
}

export const verify = (key: CryptoKey, sig: Bytes, data: Bytes) =>
  crypto.subtle.verify({ name: "Ed25519" }, key, sig, data);

/** The content key: HKDF-SHA256 of the session secret, as a non-extractable AES-256-GCM key. */
export async function contentKey(secret: Bytes, session: KeyId) {
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(session),
      info: encoder.encode("snowy content v1"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypts an object: a random nonce, then the ciphertext and tag. The object key is the
 * associated data, so the bytes can't be passed off as another object.
 */
export async function seal(key: CryptoKey, objectKey: string, plaintext: Bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(NONCE));
  const additionalData = encoder.encode(objectKey);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData },
    key,
    plaintext,
  );
  const sealed = new Uint8Array(NONCE + ciphertext.byteLength);
  sealed.set(iv);
  sealed.set(new Uint8Array(ciphertext), NONCE);
  return sealed;
}

/** Decrypts what `seal` made under the same key and object key; rejects anything else. */
export async function unseal(key: CryptoKey, objectKey: string, sealed: Bytes) {
  const additionalData = encoder.encode(objectKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: sealed.subarray(0, NONCE), additionalData },
    key,
    sealed.subarray(NONCE),
  );
  return new Uint8Array(plaintext);
}

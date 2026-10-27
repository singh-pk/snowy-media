// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Keys, signatures and encryption (src/crypto.ts), in Chromium: key ids round-trip, signatures check
// only against their key and data, and sealed objects open only under the same content key and
// object key, each with a fresh nonce.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import {
  contentKey,
  generateKeyPair,
  isKeyId,
  keyBytes,
  keyId,
  publicKey,
  seal,
  sign,
  unseal,
  verify,
} from "../src/crypto";
import { rejection } from "./support/rejection";

const encoder = new TextEncoder();
const data = encoder.encode("a chunk header");
const secret = crypto.getRandomValues(new Uint8Array(32));

test("a key id is the 32-byte public key as unpadded base64url", async () => {
  const pair = await generateKeyPair();
  const id = await keyId(pair.publicKey);
  expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(keyBytes(id).byteLength).toBe(32);
  const imported = await publicKey(id);
  const again = await keyId(imported);
  expect(again).toBe(id);
});

test("anything but a 32-byte key id is refused", () => {
  expect(() => keyBytes("abc")).toThrow(RangeError);
  expect(() => keyBytes("A".repeat(44))).toThrow(RangeError);
  expect([7, "abc"].map(isKeyId)).toEqual([false, false]);
});

test("a private key can't be exported", async () => {
  const pair = await generateKeyPair();
  expect(pair.privateKey.extractable).toBe(false);
  const error = await rejection(crypto.subtle.exportKey("pkcs8", pair.privateKey));
  expect(error).toBeInstanceOf(Error);
});

test("a signature verifies against its key and data only", async () => {
  const pair = await generateKeyPair();
  const other = await generateKeyPair();
  const sig = await sign(pair.privateKey, data);
  const id = await keyId(pair.publicKey);
  const key = await publicKey(id);
  const valid = await verify(key, sig, data);
  const otherKey = await verify(other.publicKey, sig, data);
  const otherData = await verify(key, sig, encoder.encode("another header"));
  expect(valid).toBe(true);
  expect(otherKey).toBe(false);
  expect(otherData).toBe(false);
});

test("a sealed object opens under the same content key and object key", async () => {
  const pair = await generateKeyPair();
  const session = await keyId(pair.publicKey);
  const key = await contentKey(secret, session);
  const sealed = await seal(key, "media/0/7", data);
  const opened = await unseal(key, "media/0/7", sealed);
  expect(opened).toEqual(data);
});

test("every seal uses a fresh nonce", async () => {
  const key = await contentKey(secret, "session");
  const a = await seal(key, "subs", data);
  const b = await seal(key, "subs", data);
  expect(a.subarray(0, 12)).not.toEqual(b.subarray(0, 12));
  expect(a).not.toEqual(b);
});

test("a sealed object doesn't open as another object, under another key, or altered", async () => {
  const key = await contentKey(secret, "session");
  const otherKey = await contentKey(secret, "another session");
  const sealed = await seal(key, "media/0/7", data);
  const altered = sealed.slice();
  altered[20] = (altered[20] ?? 0) ^ 1;
  const asOther = await rejection(unseal(key, "media/0/8", sealed));
  const underOther = await rejection(unseal(otherKey, "media/0/7", sealed));
  const wasAltered = await rejection(unseal(key, "media/0/7", altered));
  expect(asOther).toBeInstanceOf(Error);
  expect(underOther).toBeInstanceOf(Error);
  expect(wasAltered).toBeInstanceOf(Error);
});

test("the content key can't be exported", async () => {
  const key = await contentKey(secret, "session");
  expect(key.extractable).toBe(false);
});

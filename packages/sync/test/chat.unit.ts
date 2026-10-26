// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Chat messages and checkpoints (src/chat.ts), in Chromium: a message round-trips through its
// canonical bytes, malformed ones are refused, a checkpoint verifies only as signed by its
// author, and it proves exactly the messages that chain back from it.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import {
  decodeMessage,
  encodeMessage,
  InvalidMessageError,
  messageHash,
  proven,
  signCheckpoint,
  verifyCheckpoint,
} from "../src/chat";
import { createAuthor } from "./support/chat";
import { rejection } from "./support/rejection";

const encoder = new TextEncoder();
const alice = await createAuthor(() => 1000);
const bob = await createAuthor(() => 2000);
const hello = await alice.write({ kind: "text", text: "hello" }, 82_000_000);
const edit = await alice.write({ kind: "edit", target: { author: alice.id, seq: 1 }, text: "hi" });
const react = await alice.write({ kind: "react", target: { author: bob.id, seq: 4 }, emoji: "🎬" });
const unreact = await alice.write({
  kind: "react",
  target: { author: bob.id, seq: 4 },
  emoji: "🎬",
  text: "",
});
const remove = await alice.write({ kind: "delete", target: { author: alice.id, seq: 2 } });

const raw = (value: unknown) => encoder.encode(JSON.stringify(value));

function refusal(value: unknown) {
  try {
    decodeMessage(raw(value));
  } catch (e) {
    return e;
  }

  return undefined;
}

test("every kind of message round-trips through its canonical bytes", () => {
  for (const message of [hello, edit, react, unreact, remove]) {
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  }
});

test("the canonical bytes don't depend on field order, so every peer hashes alike", async () => {
  const reordered = Object.fromEntries(Object.entries(hello).toReversed());
  const decoded = decodeMessage(raw(reordered));
  const hashes = await Promise.all([messageHash(hello), messageHash(decoded)]);
  expect(encodeMessage(decoded)).toEqual(encodeMessage(hello));
  expect(hashes[0]).toBe(hashes[1]);
  expect(hashes[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("each message names its predecessor's hash", async () => {
  const hash = await messageHash(hello);
  expect(hello.prev).toBe("");
  expect(edit.prev).toBe(hash);
});

test("a malformed message is refused", () => {
  const bad: unknown[] = [
    [],
    { ...hello, extra: 1 },
    { ...hello, author: "abc" },
    { ...hello, author: alice.id.slice(1) },
    { ...hello, seq: 0 },
    { ...hello, seq: 1.5 },
    { ...hello, prev: edit.prev },
    { ...edit, prev: "" },
    { ...hello, hlc: "00000000000003E8" },
    { ...hello, mediaUs: -1 },
    { ...hello, mediaUs: 1.5 },
    { ...hello, mediaUs: 2 ** 53 },
    { ...hello, mediaUs: "0" },
    { ...hello, kind: "shout" },
    { ...hello, emoji: "🎬" },
    { ...hello, text: undefined },
    { ...edit, text: undefined },
    { ...edit, target: { author: alice.id } },
    { ...edit, target: { author: alice.id, seq: 1, extra: 1 } },
    { ...remove, text: "gone" },
    { ...react, emoji: "" },
    { ...react, text: "no" },
  ];

  for (const value of bad) expect(refusal(value)).toBeInstanceOf(InvalidMessageError);
  expect(() => decodeMessage(new Uint8Array([0xff]))).toThrow(InvalidMessageError);
  expect(() => encodeMessage({ ...hello, seq: 0 })).toThrow(InvalidMessageError);
});

test("an author id spelled with non-zero trailing bits is refused", () => {
  // The last of 43 base64url digits carries 2 bits that must be zero; one id has one spelling.
  const last = alice.id.at(-1)!;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const alias = alice.id.slice(0, 42) + alphabet[alphabet.indexOf(last) | 1];
  expect(refusal({ ...hello, author: alias })).toBeInstanceOf(InvalidMessageError);
});

test("a checkpoint verifies only as signed by the author it names", async () => {
  const checkpoint = await signCheckpoint(alice.pair, remove);
  const valid = await verifyCheckpoint(checkpoint);
  const otherAuthor = await verifyCheckpoint({ ...checkpoint, author: bob.id });
  const otherSeq = await verifyCheckpoint({ ...checkpoint, seq: 4 });
  const badSig = await verifyCheckpoint({ ...checkpoint, sig: "x" });
  expect([valid, otherAuthor, otherSeq, badSig]).toEqual([true, false, false, false]);
  const head = await messageHash(remove);
  expect(checkpoint.seq).toBe(5);
  expect(checkpoint.head).toBe(head);
});

test("a checkpoint can't be signed for another author's message", async () => {
  const theirs = await bob.write({ kind: "text", text: "mine" });
  const error = await rejection(signCheckpoint(alice.pair, theirs));
  expect(error).toBeInstanceOf(RangeError);
});

test("a checkpoint proves the messages that chain back from it, and no others", async () => {
  const checkpoint = await signCheckpoint(alice.pair, unreact);
  const all = alice.sent;
  const full = await proven(all, checkpoint);
  expect(full.map((m) => m.seq)).toEqual([1, 2, 3, 4]);

  // A missing message stops the chain; so does an altered one.
  const withGap = await proven([hello, react, unreact, remove], checkpoint);
  expect(withGap.map((m) => m.seq)).toEqual([3, 4]);
  const altered = await proven([hello, { ...edit, text: "forged" }, react, unreact], checkpoint);
  expect(altered.map((m) => m.seq)).toEqual([3, 4]);

  // A forged checkpoint proves nothing.
  const forged = await proven(all, { ...checkpoint, author: bob.id });
  expect(forged).toEqual([]);
});

test("a forged copy of a seq can't hide the real one from a checkpoint", async () => {
  const checkpoint = await signCheckpoint(alice.pair, unreact);
  const forgedEdit = { ...edit, text: "forged" };
  const chain = await proven([hello, forgedEdit, edit, react, unreact], checkpoint);
  expect(chain).toEqual([hello, edit, react, unreact]);
});

test("a checkpoint's walk stops at the highest seq already shown", async () => {
  const checkpoint = await signCheckpoint(alice.pair, remove);
  const sinceTwo = await proven(alice.sent, checkpoint, 2);
  expect(sinceTwo.map((m) => m.seq)).toEqual([3, 4, 5]);

  // The chain proves what it reaches on its own; the shown message only ends the walk.
  const withoutShown = await proven([react, unreact, remove], checkpoint, 2);
  expect(withoutShown.map((m) => m.seq)).toEqual([3, 4, 5]);
  const nothingNew = await proven(alice.sent, checkpoint, 5);
  expect(nothingNew).toEqual([]);
});

test("a malformed checkpoint, or a signature spelled another way, doesn't verify", async () => {
  const checkpoint = await signCheckpoint(alice.pair, remove);
  // The last of 86 base64url digits carries 4 bits that must be zero.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(checkpoint.sig.at(-1)!);
  const alias = checkpoint.sig.slice(0, 85) + alphabet[last | 1];
  const results = await Promise.all(
    [
      null,
      "checkpoint",
      [],
      { ...checkpoint, extra: 1 },
      { ...checkpoint, sig: alias },
      { ...checkpoint, head: "not a hash" },
      { ...checkpoint, seq: 0 },
    ].map((value) => verifyCheckpoint(value)),
  );
  expect(results).toEqual([false, false, false, false, false, false, false]);
});

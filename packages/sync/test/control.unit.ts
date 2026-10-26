// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The control record (src/control.ts), in Chromium: it round-trips under the key of its epoch; a
// malformed one is refused before signing; and one signed by another session, altered, carrying
// an unsigned field, under another epoch's key, or signed as another kind of record is rejected.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { decodeControl, encodeControl, type Control } from "../src/control";
import { generateKeyPair } from "../src/crypto";
import { InvalidRecordError } from "../src/signed-record";
import { rejection } from "./support/rejection";
import { createRecordSigner, json } from "./support/signed-record";

const { pair, resigned } = await createRecordSigner();
const encoder = new TextEncoder();

const control: Control = {
  epoch: 7,
  playing: true,
  mediaUs: 754_000_000,
  atUs: 1_793_000_000_500_000,
  ended: false,
};

// A control record as a caller without types might pass one, whatever its fields.
const untyped = (value: object): Control => JSON.parse(JSON.stringify(value));

test("a control record round-trips under the key of its epoch", async () => {
  const { key, bytes } = await encodeControl(pair, control);
  expect(key).toBe("control@7");
  const read = await decodeControl(pair.publicKey, key, bytes);
  expect(read).toEqual(control);
});

test("a malformed control record is refused before it is signed", async () => {
  const { ended: _, ...withoutEnded } = control;
  const bad = [
    { ...control, epoch: 0 },
    { ...control, epoch: 2 ** 53 },
    { ...control, mediaUs: -1 },
    { ...control, atUs: 1.5 },
    { ...control, playing: "yes" },
    { ...control, ended: 0 },
    withoutEnded,
    { ...control, ended: true },
    { ...control, sequence: "main" },
  ];
  const errors = await Promise.all(
    bad.map(async (c) => rejection(encodeControl(pair, untyped(c)))),
  );
  const reasons = [
    "bad epoch",
    "bad epoch",
    "bad mediaUs",
    "bad atUs",
    "bad playing",
    "bad ended",
    "bad ended",
    "bad ended",
    "unknown field sequence",
  ];
  expect(errors).toEqual(reasons.map((reason) => new InvalidRecordError(reason)));
});

test("a control record signed by another session, altered, with an unsigned field, or without a well-formed sig is rejected", async () => {
  const other = await generateKeyPair();
  const [{ key, bytes }, fromOther] = await Promise.all([
    encodeControl(pair, control),
    encodeControl(other, control),
  ]);
  const record = json(bytes);
  const altered = encoder.encode(JSON.stringify({ ...record, playing: false }));
  const added = encoder.encode(JSON.stringify({ ...record, rate: 2 }));
  const { sig, ...unsigned } = record;
  const badSigs = [unsigned, { ...unsigned, sig: 5 }, { ...unsigned, sig: String(sig).slice(1) }];
  const errors = await Promise.all([
    rejection(decodeControl(pair.publicKey, fromOther.key, fromOther.bytes)),
    rejection(decodeControl(pair.publicKey, key, altered)),
    rejection(decodeControl(pair.publicKey, key, added)),
    ...badSigs.map(async (r) =>
      rejection(decodeControl(pair.publicKey, key, encoder.encode(JSON.stringify(r)))),
    ),
  ]);
  const reasons = ["bad signature", "bad signature", "unknown field rate"];
  expect(errors).toEqual(
    [...reasons, "bad sig", "bad sig", "bad sig"].map((reason) => new InvalidRecordError(reason)),
  );
});

test("a control record under another epoch's key, or signed as another record, is rejected", async () => {
  const { key, bytes } = await encodeControl(pair, control);
  const asCatalog = await resigned(bytes, "snowy catalog v1", () => undefined);
  const errors = await Promise.all([
    rejection(decodeControl(pair.publicKey, "control@8", bytes)),
    rejection(decodeControl(pair.publicKey, key, asCatalog)),
  ]);
  expect(errors).toEqual([
    new InvalidRecordError("another epoch"),
    new InvalidRecordError("bad signature"),
  ]);
});

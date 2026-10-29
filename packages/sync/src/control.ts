// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The control record (docs/architecture.md#control-record). Only the source writes it, signed, so a
// peer can take one from anyone; a peer follows the highest epoch.

import { isCount, isRecord } from "./chat";
import type { Bytes } from "./crypto";
import {
  checkRecordSig,
  InvalidRecordError,
  onlyFields,
  parseRecord,
  signRecord,
} from "./signed-record";

const FIELDS = new Set(["epoch", "playing", "mediaUs", "atUs", "ended"]);
const DOMAIN = "snowy control v1";

export type Control = {
  /** 1, 2, 3, …: each play, pause or seek has the next. */
  epoch: number;
  playing: boolean;
  /** The position at `atUs`, in whole microseconds. */
  mediaUs: number;
  /** A moment on the source's clock: wall time in whole microseconds. */
  atUs: number;
  /** Playback reached the end, so every peer stops; an ended record is never `playing`. */
  ended: boolean;
};

const controlKey = (epoch: number) => `control@${epoch}`;

// `value` as a control record in canonical shape, its fields in order; throws an
// `InvalidRecordError` for anything else.
function checkControl(value: unknown): Control {
  if (!isRecord(value)) throw new InvalidRecordError("not an object");
  onlyFields(value, FIELDS);

  const { epoch, playing, mediaUs, atUs, ended } = value;
  if (!isCount(epoch, 1)) throw new InvalidRecordError("bad epoch");
  if (typeof playing !== "boolean") throw new InvalidRecordError("bad playing");
  if (!isCount(mediaUs, 0)) throw new InvalidRecordError("bad mediaUs");
  if (!isCount(atUs, 0)) throw new InvalidRecordError("bad atUs");
  if (typeof ended !== "boolean" || (ended && playing)) throw new InvalidRecordError("bad ended");
  return { epoch, playing, mediaUs, atUs, ended };
}

/**
 * Signs a control record with the session key. Resolves to its object key and bytes. Rejects
 * with an `InvalidRecordError` for a malformed one.
 */
export async function encodeControl(session: CryptoKeyPair, control: Control) {
  const canonical = checkControl(control);
  const bytes = await signRecord(session, DOMAIN, canonical);
  return { key: controlKey(canonical.epoch), bytes };
}

/**
 * Checks that a control record is the epoch its object key names, well formed and signed by the
 * session key, then reads it. Rejects with an `InvalidRecordError` for anything else.
 */
export async function decodeControl(sessionKey: CryptoKey, key: string, bytes: Bytes) {
  const { sig, fields } = parseRecord(bytes);
  const control = checkControl(fields);
  if (key !== controlKey(control.epoch)) throw new InvalidRecordError("another epoch");
  await checkRecordSig(sessionKey, DOMAIN, sig, control);
  return control;
}

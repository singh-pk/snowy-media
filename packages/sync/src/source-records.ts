// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A watch session's source records as a peer holds them (docs/architecture.md#catalog): the
// newest catalog, the newest control record, and each track's codec setup. Every record is signed by the session
// key, so one path takes them all, from the source's tracks, from any peer that answers a joiner,
// and the source's own as it publishes them. Each is kept with its sealed bytes, which a peer
// passes on unchanged.

import { decodeCatalog, decodeSetup, encodeCatalog, encodeSetup } from "./catalog";
import type { Catalog, CodecSetup } from "./catalog";
import { decodeControl, encodeControl, type Control } from "./control";
import { seal, unseal, type Bytes } from "./crypto";
import { InvalidRecordError } from "./signed-record";

/** A record of the source's, read. */
export type SourceRecord =
  | { kind: "catalog"; catalog: Catalog }
  | { kind: "control"; control: Control }
  | { kind: "setup"; setup: CodecSetup };

/** An object as it travels: its key, and its bytes sealed with the content key. */
export type SealedObject = { key: string; sealed: Bytes };

export type SourceRecordsOptions = {
  /** The session's public key, which signs every record. */
  sessionKey: CryptoKey;
  /** The content key, which seals the records. */
  content: CryptoKey;
  /**
   * Called with each record kept: a newer catalog or control record, or a track's first setup.
   * What it throws is reported, as the record stays kept.
   */
  onRecord?: (record: SourceRecord) => void;
};

type Held<T> = { value: T; object: SealedObject };

/** Whether an object's key names one of the source's records. */
export const isSourceKey = (key: string) =>
  key.startsWith("catalog@") || key.startsWith("control@") || key.startsWith("init/");

// Reads a record whose object key names its kind.
async function decoded(sessionKey: CryptoKey, key: string, bytes: Bytes): Promise<SourceRecord> {
  if (key.startsWith("catalog@")) {
    const catalog = await decodeCatalog(sessionKey, key, bytes);
    return { kind: "catalog", catalog };
  }

  if (key.startsWith("control@")) {
    const control = await decodeControl(sessionKey, key, bytes);
    return { kind: "control", control };
  }

  if (key.startsWith("init/")) {
    const setup = await decodeSetup(sessionKey, key, bytes);
    return { kind: "setup", setup };
  }

  throw new InvalidRecordError(`not a source record: ${key}`);
}

// Opens a sealed object, rejecting with an `InvalidRecordError` for one that doesn't open.
async function opened(content: CryptoKey, { key, sealed }: SealedObject) {
  try {
    return await unseal(content, key, sealed);
  } catch {
    throw new InvalidRecordError("doesn't open");
  }
}

/**
 * Signs and seals one of the source's records, for the source to publish. Throws an
 * `InvalidRecordError` for a malformed one.
 */
export async function sealSourceRecord(
  session: CryptoKeyPair,
  content: CryptoKey,
  record: SourceRecord,
): Promise<SealedObject> {
  const { key, bytes } = await encoded(session, record);
  const sealed = await seal(content, key, bytes);
  return { key, sealed };
}

function encoded(session: CryptoKeyPair, record: SourceRecord) {
  if (record.kind === "catalog") return encodeCatalog(session, record.catalog);
  if (record.kind === "control") return encodeControl(session, record.control);
  return encodeSetup(session, record.setup);
}

export function createSourceRecords(options: SourceRecordsOptions) {
  const held: {
    catalog?: Held<Catalog>;
    control?: Held<Control>;
    setups: Map<number, Held<CodecSetup>>;
  } = { setups: new Map() };

  // Keeps a record if it is newer than what is held, checked once it is read, since another
  // object may have been kept meanwhile. A track's setup is fixed for the session, so the first
  // is kept and a later one, which can only repeat it, is not.
  function keep(record: SourceRecord, object: SealedObject) {
    if (record.kind === "catalog") {
      if (held.catalog !== undefined && held.catalog.value.version >= record.catalog.version) {
        return false;
      }

      held.catalog = { value: record.catalog, object };
      return true;
    }

    if (record.kind === "control") {
      if (held.control !== undefined && held.control.value.epoch >= record.control.epoch) {
        return false;
      }

      held.control = { value: record.control, object };
      return true;
    }

    if (held.setups.has(record.setup.track)) return false;
    held.setups.set(record.setup.track, { value: record.setup, object });
    return true;
  }

  // Tells `onRecord`, reporting what it throws rather than rejecting `receive`: the record is
  // kept already, and a later copy of it, kept no more, would never reach `onRecord` again.
  function report(record: SourceRecord) {
    try {
      options.onRecord?.(record);
    } catch (error) {
      reportError(error);
    }
  }

  /**
   * Takes a sealed record of the source's. Resolves with whether it was kept, as newer than what
   * is held; rejects with an `InvalidRecordError`, changing nothing, for one that doesn't open,
   * isn't a source record, or doesn't check out.
   */
  async function receive(object: SealedObject) {
    const bytes = await opened(options.content, object);
    const record = await decoded(options.sessionKey, object.key, bytes);
    const kept = keep(record, object);
    if (kept) report(record);
    return kept;
  }

  /** Every record held, sealed as it came, to pass on unchanged. */
  function objects(): SealedObject[] {
    // copy: every record held, into one list.
    return [held.catalog, held.control, ...held.setups.values()].flatMap((h) =>
      h === undefined ? [] : [h.object],
    );
  }

  /**
   * Whether this peer holds the whole state a joiner needs: a catalog, a control record, and the
   * setup of every track in the catalog.
   */
  function complete() {
    const { catalog, control } = held;
    if (catalog === undefined || control === undefined) return false;
    return catalog.value.tracks.every((track) => held.setups.has(track.id));
  }

  return {
    receive,
    objects,
    complete,
    catalog: () => held.catalog?.value,
    control: () => held.control?.value,
    setup: (track: number) => held.setups.get(track)?.value,
  };
}

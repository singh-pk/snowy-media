// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A watch session's source records as a peer holds them (docs/architecture.md#catalog): the
// newest catalog, the newest control record, each track's codec setup, and each page of the
// chunk index listing the most chunks. Every record is signed by the session key, so one path
// takes them all, from the source's tracks, from any peer that answers a joiner, and the source's
// own as it publishes them. Each is kept with its sealed bytes, which a peer passes on unchanged.

import { decodeCatalog, decodeSetup, encodeCatalog, encodeSetup } from "./catalog";
import type { Catalog, CodecSetup } from "./catalog";
import {
  decodeIndexPage,
  encodeIndexPage,
  joinedBounds,
  listed,
  reachesPage,
  type IndexPage,
} from "./chunk-index";
import { decodeControl, encodeControl, type Control } from "./control";
import { seal, unseal, type Bytes, type SealedObject } from "./crypto";
import { InvalidRecordError } from "./signed-record";

/** A record of the source's, read. */
export type SourceRecord =
  | { kind: "catalog"; catalog: Catalog }
  | { kind: "control"; control: Control }
  | { kind: "setup"; setup: CodecSetup }
  | { kind: "index"; page: IndexPage };

export type SourceRecordsOptions = {
  /** The session's public key, which signs every record. */
  sessionKey: CryptoKey;
  /** The content key, which seals the records. */
  content: CryptoKey;
  /**
   * Called with each record kept: a newer catalog or control record, a track's first setup, or a
   * page of the index listing more chunks.
   * What it throws is reported, as the record stays kept.
   */
  onRecord?: (record: SourceRecord) => void;
};

type Held<T> = { value: T; object: SealedObject };

/** Whether an object's key names one of the source's records. */
export const isSourceKey = (key: string) =>
  ["catalog@", "control@", "init/", "index/"].some((prefix) => key.startsWith(prefix));

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

  if (key.startsWith("index/")) {
    const page = await decodeIndexPage(sessionKey, key, bytes);
    return { kind: "index", page };
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
  if (record.kind === "index") return encodeIndexPage(session, record.page);
  return encodeSetup(session, record.setup);
}

export function createSourceRecords(options: SourceRecordsOptions) {
  const held: {
    catalog?: Held<Catalog>;
    control?: Held<Control>;
    pages: Map<number, Held<IndexPage>>;
    setups: Map<number, Held<CodecSetup>>;
  } = { setups: new Map(), pages: new Map() };

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

    if (record.kind === "index") {
      const { page } = record.page;
      const had = held.pages.get(page);
      if (had !== undefined && listed(had.value) >= listed(record.page)) return false;
      held.pages.set(page, { value: record.page, object });
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
    return [held.catalog, held.control, ...held.setups.values(), ...held.pages.values()].flatMap(
      (h) => (h === undefined ? [] : [h.object]),
    );
  }

  /** The bounds of the chunks the index lists so far, joined from its pages. */
  const bounds = () => joinedBounds((page) => held.pages.get(page)?.value);

  // The highest page of the index held, or -1 for none, which any bounds reach.
  function lastPage() {
    let last = -1;
    for (const page of held.pages.keys()) last = Math.max(last, page);
    return last;
  }

  /**
   * Whether this peer holds the whole state a joiner needs: a catalog, a control record, the setup
   * of every track in the catalog, and no page of the index missing before the last it holds. A
   * full page never goes again, so a peer that missed one finds it only by asking for the state.
   */
  function complete() {
    const { catalog, control } = held;
    if (catalog === undefined || control === undefined) return false;
    if (!catalog.value.tracks.every((track) => held.setups.has(track.id))) return false;
    return reachesPage(bounds(), lastPage());
  }

  return {
    receive,
    objects,
    complete,
    catalog: () => held.catalog?.value,
    control: () => held.control?.value,
    setup: (track: number) => held.setups.get(track)?.value,
    bounds,
  };
}

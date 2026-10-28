// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The catalog and codec setups (docs/architecture.md#catalog). Each is signed, so a peer can take
// one from anyone, and reading one checks it holds what its object key names.

import { isCount, isRecord } from "./chat";
import type { Bytes } from "./crypto";
import {
  base64,
  checkRecordSig,
  InvalidRecordError,
  onlyFields,
  parseRecord,
  signRecord,
} from "./signed-record";

const KINDS = ["video", "audio", "subtitle"] as const;
const CATALOG_FIELDS = new Set(["version", "durationUs", "tracks", "chunkCount"]);
const TRACK_FIELDS = new Set(["id", "kind", "codec", "bitrateKbps", "language", "title"]);
const SETUP_FIELDS = new Set([
  "track",
  "codec",
  "description",
  "codedWidth",
  "codedHeight",
  "sampleRate",
  "numberOfChannels",
]);
const U16 = 0xffff;

type TrackKind = (typeof KINDS)[number];

type CatalogTrack = {
  /** The track's number in chunk headers and object keys: 0 to 65535. */
  id: number;
  kind: TrackKind;
  /** A WebCodecs codec string, or the subtitle format. */
  codec: string;
  bitrateKbps: number;
  language?: string;
  title?: string;
};

export type Catalog = {
  /** 1, 2, 3, …: each new catalog has the next, and a peer keeps the highest. */
  version: number;
  durationUs: number;
  tracks: CatalogTrack[];
  /** Set once demuxing has reached the end of the file. */
  chunkCount?: number;
};

/** What a track's decoder is configured with, as WebCodecs takes it. */
export type CodecSetup = {
  track: number;
  codec: string;
  /** The extradata, such as an `avcC` record. */
  description?: Bytes;
  codedWidth?: number;
  codedHeight?: number;
  sampleRate?: number;
  numberOfChannels?: number;
};

const catalogKey = (version: number) => `catalog@${version}`;

const setupKey = (track: number) => `init/${track}`;

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";
const isTrackId = (value: unknown): value is number => isCount(value, 0) && value <= U16;

function checkTrack(value: unknown): CatalogTrack {
  if (!isRecord(value)) throw new InvalidRecordError("a track isn't an object");
  onlyFields(value, TRACK_FIELDS);

  const { id, codec, bitrateKbps, language, title } = value;
  const kind = KINDS.find((k) => k === value.kind);
  const valid = isTrackId(id) && kind !== undefined && isText(codec) && isCount(bitrateKbps, 0);
  if (!valid) throw new InvalidRecordError("bad track");
  if (language !== undefined && !isText(language)) throw new InvalidRecordError("bad language");
  if (title !== undefined && !isText(title)) throw new InvalidRecordError("bad title");

  return {
    id,
    kind,
    codec,
    bitrateKbps,
    ...(language === undefined ? {} : { language }),
    ...(title === undefined ? {} : { title }),
  };
}

// A catalog in canonical shape: its fields in order, absent ones left out.
function checkCatalog(value: unknown): Catalog {
  if (!isRecord(value)) throw new InvalidRecordError("not an object");
  onlyFields(value, CATALOG_FIELDS);

  const { version, durationUs, tracks, chunkCount } = value;
  if (!isCount(version, 1)) throw new InvalidRecordError("bad version");
  if (!isCount(durationUs, 0)) throw new InvalidRecordError("bad durationUs");
  if (!Array.isArray(tracks)) throw new InvalidRecordError("bad tracks");

  const checked = tracks.map(checkTrack);
  const ids = new Set(checked.map((track) => track.id));
  if (ids.size !== checked.length) throw new InvalidRecordError("two tracks with one id");

  if (chunkCount !== undefined && !isCount(chunkCount, 0)) {
    throw new InvalidRecordError("bad chunkCount");
  }

  return {
    version,
    durationUs,
    tracks: checked,
    ...(chunkCount === undefined ? {} : { chunkCount }),
  };
}

const COUNTS = ["codedWidth", "codedHeight", "sampleRate", "numberOfChannels"] as const;

// A codec setup as signed, in canonical shape with its description as base64url, and as read.
function checkSetup(value: Record<string, unknown>) {
  onlyFields(value, SETUP_FIELDS);

  const { track, codec, description } = value;
  if (!isTrackId(track)) throw new InvalidRecordError("bad track");
  if (!isText(codec)) throw new InvalidRecordError("bad codec");

  const bytes = description === undefined ? undefined : descriptionBytes(description);
  const counts: Partial<Record<(typeof COUNTS)[number], number>> = {};

  for (const field of COUNTS) {
    const count = value[field];
    if (count === undefined) continue;
    if (!isCount(count, 1)) throw new InvalidRecordError(`bad ${field}`);
    counts[field] = count;
  }

  // copy: the few counts, into the record and the setup below.
  const record = { track, codec, ...(bytes === undefined ? {} : { description }), ...counts };
  const setup: CodecSetup = {
    track,
    codec,
    ...(bytes === undefined ? {} : { description: bytes }),
    // copy: as for the record.
    ...counts,
  };
  return { record, setup };
}

function decodeDescription(description: string): Bytes {
  try {
    return new Uint8Array(Uint8Array.fromBase64(description, { alphabet: "base64url" }));
  } catch {
    throw new InvalidRecordError("bad description");
  }
}

// The description's bytes, in their one base64url spelling, so one setup has one signed form.
function descriptionBytes(description: unknown) {
  if (typeof description !== "string") throw new InvalidRecordError("bad description");

  const bytes = decodeDescription(description);
  if (base64(bytes) !== description) throw new InvalidRecordError("bad description");
  return bytes;
}

/**
 * Signs a catalog with the session key. Returns its object key and bytes. Throws an
 * `InvalidRecordError` for a malformed one.
 */
export async function encodeCatalog(session: CryptoKeyPair, catalog: Catalog) {
  const canonical = checkCatalog(catalog);
  const bytes = await signRecord(session, "snowy catalog v1", canonical);
  return { key: catalogKey(canonical.version), bytes };
}

/**
 * Checks that a catalog is the one its object key names, well formed and signed by the session
 * key, then reads it. Rejects with an `InvalidRecordError` for anything else.
 */
export async function decodeCatalog(sessionKey: CryptoKey, key: string, bytes: Bytes) {
  const { sig, fields } = parseRecord(bytes);
  const catalog = checkCatalog(fields);
  if (key !== catalogKey(catalog.version)) throw new InvalidRecordError("another version");
  await checkRecordSig(sessionKey, "snowy catalog v1", sig, catalog);
  return catalog;
}

/**
 * Signs a track's codec setup with the session key. Returns its object key and bytes. Throws an
 * `InvalidRecordError` for a malformed one.
 */
export async function encodeSetup(session: CryptoKeyPair, setup: CodecSetup) {
  const { description, ...rest } = setup;
  // copy: the setup's fields, with its description as text.
  const { record } = checkSetup({
    ...rest,
    ...(description === undefined ? {} : { description: base64(description) }),
  });
  const bytes = await signRecord(session, "snowy init v1", record);
  return { key: setupKey(record.track), bytes };
}

/**
 * Checks that a codec setup is for the track its object key names, well formed and signed by the
 * session key, then reads it. Rejects with an `InvalidRecordError` for anything else.
 */
export async function decodeSetup(
  sessionKey: CryptoKey,
  key: string,
  bytes: Bytes,
): Promise<CodecSetup> {
  const { sig, fields } = parseRecord(bytes);
  const { record, setup } = checkSetup(fields);
  if (key !== setupKey(setup.track)) throw new InvalidRecordError("another track");
  await checkRecordSig(sessionKey, "snowy init v1", sig, record);
  return setup;
}

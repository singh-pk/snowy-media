// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Chat messages and checkpoints (docs/architecture.md#chat). A message's bytes are its canonical
// JSON (fields in `ChatMessage` order, absent ones left out), and every peer re-encodes what it
// parses the same way, so they all hash a message alike and a checkpoint proves its chain.

import { isHlc, type Hlc } from "./hlc";
import {
  isKeyId,
  keyId,
  publicKey,
  sigBytes,
  sign,
  verify,
  type Bytes,
  type KeyId,
} from "./crypto";

const KINDS = ["text", "edit", "delete", "react"] as const;
const FIELDS = new Set([
  "author",
  "seq",
  "prev",
  "hlc",
  "mediaUs",
  "kind",
  "target",
  "text",
  "emoji",
]);
// A SHA-256 hash, as unpadded base64url.
const HASH = /^[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const CHECKPOINT_DOMAIN = encoder.encode("snowy checkpoint v1\n");

type ChatKind = (typeof KINDS)[number];

/** The message an edit, delete or reaction applies to. */
export type ChatTarget = { author: KeyId; seq: number };

export type ChatMessage = {
  author: KeyId;
  /** 1, 2, 3, … per author. */
  seq: number;
  /** The hash of the author's previous message, or "" for seq 1. */
  prev: string;
  hlc: Hlc;
  /** The sender's playhead when sending, in microseconds of media time. */
  mediaUs: number;
  kind: ChatKind;
  target?: ChatTarget;
  /** The text of a `text` or `edit`; "" on a `react` removes the reaction. */
  text?: string;
  emoji?: string;
};

/** The author's signature over the hash of its newest message. */
export type Checkpoint = { author: KeyId; seq: number; head: string; sig: string };

/** Thrown for bytes that aren't a well-formed chat message. */
export class InvalidMessageError extends Error {
  constructor(reason: string) {
    super(`Invalid chat message: ${reason}`);
    this.name = "InvalidMessageError";
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isCount = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;

const isSeq = (value: unknown) => isCount(value, 1);

function checkTarget(value: unknown): ChatTarget {
  if (!isRecord(value) || Object.keys(value).length !== 2) {
    throw new InvalidMessageError("bad target");
  }

  if (!isKeyId(value.author) || !isSeq(value.seq)) throw new InvalidMessageError("bad target");
  return { author: value.author, seq: value.seq };
}

function checkKindFields(kind: ChatKind, m: Record<string, unknown>) {
  const has = (field: string) => m[field] !== undefined;

  if (kind === "text") {
    if (has("target") || has("emoji") || typeof m.text !== "string") {
      throw new InvalidMessageError("a text message has text only");
    }

    return { text: m.text };
  }

  const target = checkTarget(m.target);

  if (kind === "delete") {
    if (has("text") || has("emoji")) throw new InvalidMessageError("a delete has a target only");
    return { target };
  }

  if (kind === "edit") {
    if (has("emoji") || typeof m.text !== "string") {
      throw new InvalidMessageError("an edit has a target and text");
    }

    return { target, text: m.text };
  }

  if (typeof m.emoji !== "string" || m.emoji === "" || (has("text") && m.text !== "")) {
    throw new InvalidMessageError("a reaction has a target, an emoji and at most empty text");
  }

  return has("text") ? { target, text: "", emoji: m.emoji } : { target, emoji: m.emoji };
}

/**
 * Checks an untrusted value, returning it in canonical shape. Throws an `InvalidMessageError`
 * for anything else.
 */
export function checkMessage(value: unknown): ChatMessage {
  if (!isRecord(value)) throw new InvalidMessageError("not an object");

  const unknown = Object.keys(value).find((k) => !FIELDS.has(k));
  if (unknown !== undefined) throw new InvalidMessageError(`unknown field ${unknown}`);
  if (!isKeyId(value.author)) throw new InvalidMessageError("bad author");
  if (!isSeq(value.seq)) throw new InvalidMessageError("bad seq");

  const prev = value.prev;
  const prevValid = typeof prev === "string" && (value.seq === 1 ? prev === "" : HASH.test(prev));
  if (!prevValid) throw new InvalidMessageError("bad prev");
  if (!isHlc(value.hlc)) throw new InvalidMessageError("bad hlc");
  if (!isCount(value.mediaUs, 0)) throw new InvalidMessageError("bad mediaUs");

  const kind = KINDS.find((k) => k === value.kind);
  if (kind === undefined) throw new InvalidMessageError("bad kind");

  return {
    author: value.author,
    seq: value.seq,
    prev,
    hlc: value.hlc,
    mediaUs: value.mediaUs,
    kind,
    // copy: once per message read, its kind's fields.
    ...checkKindFields(kind, value),
  };
}

/** A message's canonical bytes. Throws an `InvalidMessageError` for a malformed one. */
export const encodeMessage = (message: ChatMessage): Bytes =>
  encoder.encode(JSON.stringify(checkMessage(message)));

function parseJson(bytes: Bytes): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new InvalidMessageError("not UTF-8 JSON");
  }
}

/** Reads and checks a message's bytes. Throws an `InvalidMessageError` for anything else. */
export function decodeMessage(bytes: Bytes): ChatMessage {
  return checkMessage(parseJson(bytes));
}

/** The SHA-256 of a message's canonical bytes, as unpadded base64url: what `prev` names. */
export async function messageHash(message: ChatMessage) {
  const hash = await crypto.subtle.digest("SHA-256", encodeMessage(message));
  return new Uint8Array(hash).toBase64({ alphabet: "base64url", omitPadding: true });
}

// The bytes a checkpoint signs start with a domain prefix, so that its signature can't pass for
// anything else the peer key signs.
function checkpointBytes({ author, seq, head }: Omit<Checkpoint, "sig">) {
  const body = encoder.encode(JSON.stringify({ author, seq, head }));
  const bytes = new Uint8Array(CHECKPOINT_DOMAIN.byteLength + body.byteLength);
  bytes.set(CHECKPOINT_DOMAIN);
  bytes.set(body, CHECKPOINT_DOMAIN.byteLength);
  return bytes;
}

export async function signCheckpoint(
  peer: CryptoKeyPair,
  newest: ChatMessage,
): Promise<Checkpoint> {
  const author = await keyId(peer.publicKey);
  if (newest.author !== author) throw new RangeError("a checkpoint is signed by its author");

  const head = await messageHash(newest);
  const signed = { author, seq: newest.seq, head };
  const sig = await sign(peer.privateKey, checkpointBytes(signed));
  // copy: once per checkpoint, the signed fields with their signature.
  return { ...signed, sig: sig.toBase64({ alphabet: "base64url", omitPadding: true }) };
}

/**
 * Whether an untrusted value is a well-formed checkpoint, with no other fields, signed by the
 * author it names.
 */
export async function verifyCheckpoint(checkpoint: unknown) {
  const fields = checkCheckpoint(checkpoint);
  if (fields === undefined) return false;

  const { author, seq, head, sig } = fields;
  const key = await publicKey(author);
  return verify(key, sigBytes(sig)!, checkpointBytes({ author, seq, head }));
}

/** An untrusted value as a well-formed checkpoint, or undefined. Doesn't check the signature. */
export function checkCheckpoint(value: unknown): Checkpoint | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 4) return undefined;

  const { author, seq, head, sig } = value;

  if (!isKeyId(author) || !isSeq(seq) || typeof head !== "string" || !HASH.test(head)) {
    return undefined;
  }

  if (typeof sig !== "string" || sigBytes(sig) === undefined) return undefined;
  return { author, seq, head, sig };
}

/**
 * The messages a checkpoint proves, in seq order: the one it names, then each earlier one that
 * the `prev` of the message after it names, stopping at the first seq missing or not matching.
 * A checkpoint that doesn't verify proves none, and messages after it wait for a later one. Pass
 * every message held for the author, so a chain can run through them, and `since`, the author's
 * highest seq already shown: the walk stops once it links to that message, which is left out.
 * Several messages for one seq are fine; only the one whose hash the chain names counts, so a
 * forged copy can't hide the real one.
 */
export async function proven(messages: ChatMessage[], checkpoint: Checkpoint, since = 0) {
  const valid = await verifyCheckpoint(checkpoint);
  if (!valid) return [];

  const bySeq = Map.groupBy(
    messages.filter((m) => m.author === checkpoint.author && m.seq >= since),
    (m) => m.seq,
  );
  const chain: ChatMessage[] = [];
  let expected = checkpoint.head;

  for (let seq = checkpoint.seq; seq >= Math.max(since, 1); seq--) {
    const message = await chained(bySeq.get(seq) ?? [], expected);
    if (message === undefined) break;
    if (seq === since) break;
    chain.push(message);
    expected = message.prev;
  }

  chain.reverse();
  return chain;
}

async function chained(candidates: ChatMessage[], expected: string) {
  for (const message of candidates) {
    const hash = await messageHash(message);
    if (hash === expected) return message;
  }

  return undefined;
}

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Chat in the local store (docs/architecture.md#local-store). It writes through OPFS sync access
// handles, so it runs in a dedicated worker. The store is this origin's own, so records are
// checked for shape, not signatures.

import { checkCheckpoint, checkMessage, type ChatMessage, type Checkpoint } from "./chat";
import { isKeyId, type KeyId } from "./crypto";

/** In the order written. */
export type ChatRecords = { messages: ChatMessage[]; checkpoints: Checkpoint[] };

export type ChatAppend = { messages?: ChatMessage[]; checkpoint?: Checkpoint | undefined };

/** An author's log holds a complete line that isn't a well-formed record by that author. */
export class CorruptChatLogError extends Error {
  override name = "CorruptChatLogError";
}

/** An author's open log, with the seqs written to it, so that none is written twice. */
type Log = {
  handle: FileSystemSyncAccessHandle;
  size: number;
  messages: Set<number>;
  checkpoints: Set<number>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const NEWLINE = 0x0a;

function parse(line: Uint8Array, author: KeyId) {
  try {
    const value: unknown = JSON.parse(decoder.decode(line));
    if (typeof value !== "object" || value === null) return undefined;

    if ("message" in value) {
      const message = checkMessage(value.message);
      return message.author === author ? { message } : undefined;
    }

    if ("checkpoint" in value) {
      const checkpoint = checkCheckpoint(value.checkpoint);
      return checkpoint?.author === author ? { checkpoint } : undefined;
    }
  } catch {
    // Not JSON, or not a message.
  }

  return undefined;
}

// Whether any complete line from `start` on is a record by `author`.
function recordAfter(bytes: Uint8Array, start: number, author: KeyId) {
  let at = start;

  while (at < bytes.length) {
    const newline = bytes.indexOf(NEWLINE, at);
    if (newline === -1) return false;
    if (parse(bytes.subarray(at, newline), author) !== undefined) return true;
    at = newline + 1;
  }

  return false;
}

// Reads an author's log, and cuts off the end a crash tore.
function read(handle: FileSystemSyncAccessHandle, author: KeyId) {
  const bytes = new Uint8Array(handle.getSize());
  handle.read(bytes, { at: 0 });
  const records: ChatRecords = { messages: [], checkpoints: [] };
  let end = 0;

  while (end < bytes.length) {
    const newline = bytes.indexOf(NEWLINE, end);
    if (newline === -1) break;

    const record = parse(bytes.subarray(end, newline), author);

    if (record === undefined) {
      if (recordAfter(bytes, newline + 1, author)) {
        throw new CorruptChatLogError(`chat/${author}: bad record at ${end}`);
      }

      break;
    }

    if ("message" in record) records.messages.push(record.message);
    else records.checkpoints.push(record.checkpoint);
    end = newline + 1;
  }

  if (end < bytes.length) {
    handle.truncate(end);
    handle.flush();
  }

  return { records, size: end };
}

async function open(dir: FileSystemDirectoryHandle, author: KeyId) {
  const file = await dir.getFileHandle(author, { create: true });
  const handle = await file.createSyncAccessHandle();

  try {
    const { records, size } = read(handle, author);
    const messages = new Set(records.messages.map((m) => m.seq));
    const checkpoints = new Set(records.checkpoints.map((cp) => cp.seq));
    return { log: { handle, size, messages, checkpoints }, records };
  } catch (error) {
    handle.close();
    throw error;
  }
}

/**
 * Opens the chat in a session's OPFS directory, reading what every author's log holds. Only one
 * store may have a session open at a time: each log's access handle locks its file. Rejects,
 * holding no file, with a `CorruptChatLogError` or for a session open elsewhere.
 */
export async function openChatStore(session: FileSystemDirectoryHandle) {
  const dir = await session.getDirectoryHandle("chat", { create: true });
  const logs = new Map<KeyId, Promise<Log>>();
  const records = new Map<KeyId, ChatRecords>();

  try {
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind !== "file" || !isKeyId(name)) continue;

      const opened = await open(dir, name);
      logs.set(name, Promise.resolve(opened.log));
      records.set(name, opened.records);
    }
  } catch (error) {
    await close();
    throw error;
  }

  // Opens a new author's log. Kept as a promise, so two appends open it once; one that fails is
  // forgotten, for the next append to try again.
  async function create(author: KeyId) {
    try {
      const { log } = await open(dir, author);
      return log;
    } catch (error) {
      logs.delete(author);
      throw error;
    }
  }

  function logOf(author: KeyId) {
    const existing = logs.get(author);
    if (existing !== undefined) return existing;

    const opening = create(author);
    logs.set(author, opening);
    return opening;
  }

  /**
   * Appends an author's messages and checkpoint, skipping any seq already written, and flushes.
   * The first copy written of each seq is the one kept, as in the holdings. Rejects, having
   * written nothing, if the write or flush fails.
   */
  async function append(author: KeyId, { messages = [], checkpoint }: ChatAppend) {
    const log = await logOf(author);
    const fresh = messages.filter((m) => !log.messages.has(m.seq));
    const proof = checkpoint !== undefined && !log.checkpoints.has(checkpoint.seq);
    const lines = fresh.map((message) => JSON.stringify({ message }));
    if (proof) lines.push(JSON.stringify({ checkpoint }));
    if (lines.length === 0) return;

    const bytes = encoder.encode(`${lines.join("\n")}\n`);

    try {
      const written = log.handle.write(bytes, { at: log.size });
      if (written !== bytes.length) throw new Error(`chat/${author}: short write`);
      log.handle.flush();
    } catch (error) {
      log.handle.truncate(log.size);
      throw error;
    }

    log.size += bytes.length;
    for (const m of fresh) log.messages.add(m.seq);
    if (proof) log.checkpoints.add(checkpoint.seq);
  }

  /** Releases every log's file, for the session to be opened again or deleted. */
  async function close() {
    const opened = await Promise.allSettled(logs.values());

    for (const result of opened) {
      if (result.status === "fulfilled") result.value.handle.close();
    }

    logs.clear();
  }

  return { records, append, close };
}

/**
 * This peer's own messages to chain on from after a reload: the last one written, and those
 * after its newest checkpoint, which may never have been published and are sent again.
 */
export function unsent({ messages, checkpoints }: ChatRecords) {
  // copy: in seq order, without reordering the caller's.
  const sorted = messages.toSorted((a, b) => a.seq - b.seq);
  const sent = checkpoints.reduce((max, cp) => Math.max(max, cp.seq), 0);
  return { last: sorted.at(-1), pending: sorted.filter((m) => m.seq > sent) };
}

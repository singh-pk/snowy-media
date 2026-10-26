// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Chat in the local store (src/chat-store.ts), in Chromium's OPFS: what is appended reads back
// after reopening, a seq is written once and only once its append succeeds, a last record torn
// by a crash is cut off and the log carries on after it, a log corrupt before its end isn't
// opened, a file that isn't an author's is left alone, and this peer's
// unsent messages are those after its newest checkpoint.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { signCheckpoint } from "../src/chat";
import { CorruptChatLogError, openChatStore, unsent } from "../src/chat-store";
import { createAuthor } from "./support/chat";
import { rejection } from "./support/rejection";

const alice = await createAuthor(() => 1000);
const bob = await createAuthor(() => 2000);
const a1 = await alice.write({ kind: "text", text: "a1" });
const a2 = await alice.write({ kind: "text", text: "a2" });
const a3 = await alice.write({ kind: "text", text: "a3" });
const a4 = await alice.write({ kind: "text", text: "a4" });
const b1 = await bob.write({ kind: "text", text: "b1" });
const [cp2, cp4, bcp1] = await Promise.all([
  signCheckpoint(alice.pair, a2),
  signCheckpoint(alice.pair, a4),
  signCheckpoint(bob.pair, b1),
]);
const encoder = new TextEncoder();

// A session directory of its own: every test file shares the origin's OPFS.
async function session() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(`session-${crypto.randomUUID()}`, { create: true });
}

// Appends raw bytes to a log, as a crash mid-write could leave it.
async function scribble(dir: FileSystemDirectoryHandle, author: string, text: string) {
  const chat = await dir.getDirectoryHandle("chat");
  const file = await chat.getFileHandle(author, { create: true });
  const handle = await file.createSyncAccessHandle();
  handle.write(encoder.encode(text), { at: handle.getSize() });
  handle.flush();
  handle.close();
}

test("what is appended reads back after reopening, each author in a log of its own", async () => {
  const dir = await session();
  const store = await openChatStore(dir);
  expect(store.records.size).toBe(0);
  await store.append(alice.id, { messages: [a1, a2], checkpoint: cp2 });
  await store.append(bob.id, { messages: [b1], checkpoint: bcp1 });
  await store.close();

  const reopened = await openChatStore(dir);
  expect(reopened.records.get(alice.id)).toEqual({ messages: [a1, a2], checkpoints: [cp2] });
  expect(reopened.records.get(bob.id)).toEqual({ messages: [b1], checkpoints: [bcp1] });
  await reopened.close();
});

test("a seq already written isn't written again, whichever copy comes later", async () => {
  const dir = await session();
  const store = await openChatStore(dir);
  await store.append(alice.id, { messages: [a1, a2] });
  await store.append(alice.id, { messages: [a2, a3], checkpoint: cp2 });
  await store.append(alice.id, { messages: [{ ...a3, text: "another" }], checkpoint: cp2 });
  await store.close();

  const reopened = await openChatStore(dir);
  expect(reopened.records.get(alice.id)).toEqual({ messages: [a1, a2, a3], checkpoints: [cp2] });
  await reopened.close();
});

// Alice's log holding a1 with `tail` after it, as a crash can leave it: what reopening reads of
// it, and what a further reopening reads after a2 is appended.
async function afterCrash(tail: string) {
  const dir = await session();
  const store = await openChatStore(dir);
  await store.append(alice.id, { messages: [a1] });
  await store.close();
  await scribble(dir, alice.id, tail);

  const reopened = await openChatStore(dir);
  const read = reopened.records.get(alice.id);
  await reopened.append(alice.id, { messages: [a2] });
  await reopened.close();
  const again = await openChatStore(dir);
  const carriedOn = again.records.get(alice.id)?.messages;
  await again.close();
  return { read, carriedOn };
}

test("a torn last record, and a bad line before it, are cut off, and the log carries on after them", async () => {
  const { read, carriedOn } = await afterCrash(`\0\n{"message":{"author":"${alice.id}"`);
  expect(read).toEqual({ messages: [a1], checkpoints: [] });
  expect(carriedOn).toEqual([a1, a2]);
});

test("bad lines at the end, as a crash can leave, are cut off", async () => {
  // Garbage, a value that isn't a record, and another author's message and checkpoint.
  const others = [{ message: b1 }, { checkpoint: bcp1 }].map((r) => JSON.stringify(r)).join("\n");
  const { read, carriedOn } = await afterCrash(`\0\0\0\nnull\n${others}\n`);
  expect(read?.messages).toEqual([a1]);
  expect(carriedOn).toEqual([a1, a2]);
});

test("a record after a bad line makes the store refuse to open, holding no file", async () => {
  const dir = await session();
  const store = await openChatStore(dir);
  await store.append(alice.id, { messages: [a1] });
  await store.append(bob.id, { messages: [b1] });
  await store.close();
  await scribble(
    dir,
    alice.id,
    `${JSON.stringify({ message: b1 })}\n${JSON.stringify({ message: a2 })}\n`,
  );

  const error = await rejection(openChatStore(dir));
  expect(error).toBeInstanceOf(CorruptChatLogError);

  // Every log it opened was released: each file can be locked again.
  const chat = await dir.getDirectoryHandle("chat");

  for (const author of [alice.id, bob.id]) {
    const file = await chat.getFileHandle(author);
    const handle = await file.createSyncAccessHandle();
    handle.close();
  }
});

test("an append that fails before writing leaves its seq free", async () => {
  const dir = await session();
  const store = await openChatStore(dir);
  await store.append(alice.id, { messages: [a1] });
  const unwritable = {
    ...a2,
    toJSON: () => {
      throw new Error("can't write");
    },
  };
  const error = await rejection(store.append(alice.id, { messages: [unwritable] }));
  expect(error).toBeInstanceOf(Error);
  await store.append(alice.id, { messages: [a2] });
  await store.close();

  const reopened = await openChatStore(dir);
  expect(reopened.records.get(alice.id)?.messages).toEqual([a1, a2]);
  await reopened.close();
});

test("a file that isn't an author's log is left alone", async () => {
  const dir = await session();
  const store = await openChatStore(dir);
  await store.close();
  await scribble(dir, "notes", "not a log");
  const reopened = await openChatStore(dir);
  expect(reopened.records.size).toBe(0);
  await reopened.close();

  const chat = await dir.getDirectoryHandle("chat");
  const file = await chat.getFileHandle("notes");
  const kept = await file.getFile();
  const text = await kept.text();
  expect(text).toBe("not a log");
});

test("a new author's log that fails to open is tried again on the next append", async () => {
  const dir = await session();
  const store = await openChatStore(dir);
  // Held elsewhere, so the store can't lock it.
  const chat = await dir.getDirectoryHandle("chat");
  const file = await chat.getFileHandle(alice.id, { create: true });
  const held = await file.createSyncAccessHandle();
  const error = await rejection(store.append(alice.id, { messages: [a1] }));
  expect(error).toBeInstanceOf(DOMException);
  held.close();

  await store.append(alice.id, { messages: [a1] });
  await store.close();
  const reopened = await openChatStore(dir);
  expect(reopened.records.get(alice.id)?.messages).toEqual([a1]);
  await reopened.close();
});

test("two appends for a new author open its log once", async () => {
  const dir = await session();
  const store = await openChatStore(dir);
  await Promise.all([
    store.append(alice.id, { messages: [a1] }),
    store.append(alice.id, { messages: [a2] }),
  ]);
  await store.close();
  const reopened = await openChatStore(dir);
  expect(reopened.records.get(alice.id)?.messages).toEqual([a1, a2]);
  await reopened.close();
});

test("a session's chat is open in one store at a time", async () => {
  const dir = await session();
  const store = await openChatStore(dir);
  await store.append(alice.id, { messages: [a1] });
  const error = await rejection(openChatStore(dir));
  expect(error).toBeInstanceOf(DOMException);
  await store.close();
});

test("this peer's unsent messages are those after its newest checkpoint", () => {
  expect(unsent({ messages: [a3, a1, a4, a2], checkpoints: [cp2] })).toEqual({
    last: a4,
    pending: [a3, a4],
  });
  expect(unsent({ messages: [a1, a2, a3, a4], checkpoints: [cp2, cp4] })).toEqual({
    last: a4,
    pending: [],
  });
  expect(unsent({ messages: [], checkpoints: [] })).toEqual({ last: undefined, pending: [] });
});

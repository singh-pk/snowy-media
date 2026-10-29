// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// What the source sends (src/source-sender.ts), in Chromium, over links in memory: one chunk each
// time the stream is ready, live in the push queue's order or to the peer that asked, on its newest
// link; `gone` for a chunk that can't be cut again, and a live one skipped; requests, cancels and
// `busy` through the links, and a peer's requests dropped once its last link closes; and sending
// stopped by a chunk that can't be read, or by `stop`.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import type { Catalog } from "../src/catalog";
import { chunkKey } from "../src/chunk";
import { createSourceSender } from "../src/source-sender";
import { createHearing, spell } from "./support/hearing";
import { createNetwork } from "./support/memory-link";

const tracks: Catalog["tracks"] = [
  { id: 0, kind: "video", codec: "avc1.640028", bitrateKbps: 4_800 },
  { id: 1, kind: "audio", codec: "opus", bitrateKbps: 128, language: "en" },
  { id: 2, kind: "subtitle", codec: "webvtt", bitrateKbps: 1 },
];
const SECOND = 1_000_000;

// Waits a task, by which every microtask queued before it has run.
async function task() {
  const { port1, port2 } = new MessageChannel();
  const { promise, resolve } = Promise.withResolvers<void>();
  port2.addEventListener("message", () => resolve());
  port2.start();
  port1.postMessage(null);
  await promise;
}

// The source, with its stream ready at once unless `held`, a chunk of any slot cut on request
// unless `missing` or `broken` names it, in the order `asked`, calling `cutting` as it does; and
// what it sent live and to linked peers, and its stop, as heard events. What goes live is heard at
// once, and what goes on a link a task later, so `asked` holds the order chunks went in.
function source({ held = false } = {}) {
  const net = createNetwork();
  const { heard, hear, until } = createHearing();
  const readies = createHearing();
  const at = {
    asked: [] as string[],
    held,
    waiting: [] as Array<() => void>,
    missing: new Set<string>(),
    broken: new Map<string, Error>(),
    stopped: [] as unknown[],
    cutting: () => {},
  };

  const sender = createSourceSender({
    tracks,
    ready: async () => {
      readies.hear("ready");
      if (!at.held) return;
      const { promise, resolve } = Promise.withResolvers<void>();
      at.waiting.push(resolve);
      await promise;
    },
    chunk: async (slot) => {
      const key = chunkKey(slot);
      at.asked.push(`${slot.track}:${slot.index}`);
      at.cutting();
      const error = at.broken.get(key);
      if (error !== undefined) throw error;
      return at.missing.has(key) ? undefined : new Uint8Array([slot.track, slot.index]);
    },
    live: (slot) => hear(`live ${slot.track}:${slot.index}`),
    stopped: (error) => {
      at.stopped.push(error);
      hear("stopped");
    },
  });
  sender.select([1]);

  // Lets the stream take chunks from now on.
  function release() {
    at.held = false;
    for (const resolve of at.waiting.splice(0)) resolve();
  }

  // Cuts the next `count` chunks, 2 s each, from `from`.
  function cut(count: number, from = 0) {
    for (let index = from; index < from + count; index++) {
      sender.cut(index * 2 * SECOND, (index + 1) * 2 * SECOND);
    }
  }

  // A link from the source to `peer`; what the source sends on it is heard as `tag …`.
  function link(peer: string, tag = peer) {
    const [mine, theirs] = net.pair("source", peer);
    theirs.on("message", (value) => hear(`${tag} ${spell(value)}`));
    theirs.on("object", (key) => hear(`${tag} deliver ${key}`));
    sender.connect(mine);
    return theirs;
  }

  return {
    sender,
    at,
    heard,
    until,
    readied: readies.until,
    release,
    cut,
    link,
    settle: net.settle,
  };
}

test("chunks go live as cut, each index subtitles, selected audio, then video", async () => {
  const s = source();
  s.cut(2);
  await s.until(6);
  expect(s.heard).toEqual(["live 2:0", "live 1:0", "live 0:0", "live 2:1", "live 1:1", "live 0:1"]);
});

test("one chunk goes each time the stream is ready", async () => {
  const s = source({ held: true });
  s.cut(1);
  await Promise.resolve();
  expect(s.heard).toEqual([]);
  expect(s.at.waiting).toHaveLength(1);
  s.at.waiting.shift()!();
  await s.until(1);
  expect(s.heard).toEqual(["live 2:0"]);
  // The next waits for the stream again.
  await s.readied(2);
  expect(s.at.waiting).toHaveLength(1);
  expect(s.heard).toHaveLength(1);
});

test("a chunk a peer asked for goes to it, on its newest link, ahead of the push", async () => {
  const s = source({ held: true });
  s.cut(4);
  s.link("bob", "old");
  const bob = s.link("bob", "new");
  bob.send({ type: "request", track: 0, index: 3, priority: "urgent" });
  await s.settle();
  s.release();
  await s.until(13);
  expect(s.at.asked.slice(0, 2)).toEqual(["0:3", "2:0"]);
  expect(s.heard.filter((event) => !event.startsWith("live"))).toEqual(["new deliver media/0/3"]);
});

test("a chunk that can't be cut again is gone to its asker, and skipped live", async () => {
  const s = source({ held: true });
  s.at.missing.add("media/0/0");
  s.at.missing.add("media/1/1");
  s.cut(2);
  const bob = s.link("bob");
  bob.send({ type: "request", track: 0, index: 0, priority: "urgent" });
  await s.settle();
  s.release();
  await s.until(5);
  await s.settle();
  expect(s.at.asked).toEqual(["0:0", "2:0", "1:0", "0:0", "2:1", "1:1", "0:1"]);
  expect(s.heard).toEqual(["live 2:0", "live 1:0", "live 2:1", "live 0:1", "bob gone 0:0"]);
});

test("requests beyond a peer's room are busy, and a cancel takes one out", async () => {
  const s = source({ held: true });
  s.cut(1);
  s.link("bob", "old");
  const bob = s.link("bob", "new");

  for (const index of [1, 2, 3, 4, 5]) {
    bob.send({ type: "request", track: 0, index, priority: "background" });
  }

  bob.send({ type: "cancel", track: 0, index: 2 });
  await s.settle();
  expect(s.heard).toEqual(["new busy 0:5"]);
  s.cut(5, 1);
  s.release();
  await s.until(1 + 18 + 3);
  const delivered = s.heard.filter((event) => event.includes("deliver"));
  expect(delivered).toEqual([
    "new deliver media/0/1",
    "new deliver media/0/3",
    "new deliver media/0/4",
  ]);
});

test("a peer's requests go with its last link, not before", async () => {
  const s = source({ held: true });
  s.cut(3);
  const old = s.link("bob", "old");
  const bob = s.link("bob", "new");
  bob.send({ type: "request", track: 0, index: 1, priority: "background" });
  old.send({ type: "request", track: 0, index: 2, priority: "background" });
  await s.settle();
  bob.close();
  await s.settle();
  s.release();
  await s.until(11);
  expect(s.heard.filter((event) => event.includes("deliver"))).toEqual([
    "old deliver media/0/1",
    "old deliver media/0/2",
  ]);

  old.close();
  const carol = s.link("carol");
  bob.send({ type: "request", track: 0, index: 0, priority: "urgent" });
  carol.send({ type: "request", track: 0, index: 0, priority: "urgent" });
  await s.until(12);
  await s.settle();
  expect(s.heard.slice(11)).toEqual(["carol deliver media/0/0"]);
});

test("a chunk that can't be read stops sending, once", async () => {
  const s = source({ held: true });
  const broken = new DOMException("file", "NotReadableError");
  s.at.broken.set("media/1/0", broken);
  s.cut(2);
  s.release();
  await s.until(2);
  await s.settle();
  expect(s.heard).toEqual(["live 2:0", "stopped"]);
  expect(s.at.stopped).toEqual([broken]);
  expect(s.at.asked).toEqual(["2:0", "1:0"]);
});

test("a peer whose last link closed is sent nothing it asked for", async () => {
  const s = source({ held: true });
  s.cut(1);
  const bob = s.link("bob");
  bob.send({ type: "request", track: 0, index: 0, priority: "background" });
  await s.settle();
  bob.close();
  await s.settle();
  s.release();
  await s.until(3);
  await task();
  expect(s.at.asked).toEqual(["2:0", "1:0", "0:0"]);
});

test("stop ends sending, idle, waiting for the stream or cutting, and other messages are ignored", async () => {
  const s = source();
  const bob = s.link("bob");
  bob.send({ type: "chat-request", author: "carol", firstSeq: 0 });
  bob.send({ type: "busy", track: 0, index: 0 });
  s.cut(1);
  await s.until(3);
  s.sender.stop();
  s.cut(1, 1);
  bob.send({ type: "request", track: 0, index: 0, priority: "urgent" });
  await s.settle();
  await task();
  expect(s.heard).toEqual(["live 2:0", "live 1:0", "live 0:0"]);
  expect(s.at.asked).toHaveLength(3);

  const waiting = source({ held: true });
  waiting.cut(1);
  waiting.sender.stop();
  waiting.release();
  await task();
  expect(waiting.at.asked).toEqual([]);

  const cutting = source();
  cutting.at.cutting = () => cutting.sender.stop();
  cutting.cut(1);
  await task();
  expect(cutting.at.asked).toEqual(["2:0"]);
  expect(cutting.heard).toEqual([]);
});

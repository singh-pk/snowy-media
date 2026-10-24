// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// What the source sends next (src/push-queue.ts), in Chromium: ahead of the playhead, each index
// goes subtitles, selected audio, then video, each chunk live once and only up to the push
// horizon; what isn't cut waits; a seek target's chunks go first, then chunks peers asked for,
// then the rest ahead, and background requests only when nothing else can go; an audio track
// selected late joins from the playhead, and one deselected stops; chunks of any length are found
// by time; and requests are cancelled, dropped with their peer, queued once, refused when they
// name no chunk, and handed back for `gone` once the last chunk comes before them.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import type { Catalog } from "../src/catalog";
import { createPushQueue, PUSH_HORIZON_US, type Send } from "../src/push-queue";

const tracks: Catalog["tracks"] = [
  { id: 0, kind: "video", codec: "avc1.640028", bitrateKbps: 4_800 },
  { id: 1, kind: "audio", codec: "opus", bitrateKbps: 128, language: "en" },
  { id: 2, kind: "audio", codec: "opus", bitrateKbps: 128, language: "fr" },
  { id: 3, kind: "subtitle", codec: "webvtt", bitrateKbps: 1 },
];
const SECOND = 1_000_000;

// A queue with `count` chunks cut, 2 s each, English audio selected, and how often it said
// something was queued.
function queue(count: number) {
  const queued = { count: 0 };
  const q = createPushQueue({ tracks, onQueued: () => queued.count++ });
  q.select([1]);
  for (let index = 0; index < count; index++) cut(q, index);
  return { q, queued };
}

// Cuts the next chunk, `index`, 2 s long.
function cut(q: ReturnType<typeof createPushQueue>, index: number) {
  q.cut(index * 2 * SECOND, (index + 1) * 2 * SECOND);
}

// Takes up to `count` sends, in a short spelling: `track:index`, or `peer>track:index`.
function drain(q: ReturnType<typeof createPushQueue>, count = Infinity) {
  const taken: string[] = [];

  for (let send: Send | undefined = q.next(); send !== undefined; send = q.next()) {
    const { track, index } = send.slot;
    taken.push(send.to === "track" ? `${track}:${index}` : `${send.peer}>${track}:${index}`);
    if (taken.length === count) break;
  }

  return taken;
}

test("ahead of the playhead, each index goes subtitles, selected audio, then video, each chunk once", () => {
  const { q } = queue(3);
  expect(drain(q)).toEqual(["3:0", "1:0", "0:0", "3:1", "1:1", "0:1", "3:2", "1:2", "0:2"]);
  q.playhead(0);
  expect(drain(q)).toEqual([]);
});

test("nothing goes past the push horizon, which moves with the playhead", () => {
  const count = PUSH_HORIZON_US / (2 * SECOND) + 10;
  const { q } = queue(count);
  const sent = drain(q);
  expect(sent.length).toBe((PUSH_HORIZON_US / (2 * SECOND)) * 3);
  expect(sent.at(-1)).toBe(`0:${PUSH_HORIZON_US / (2 * SECOND) - 1}`);

  q.playhead(4 * SECOND);
  expect(drain(q)).toEqual([
    `3:${PUSH_HORIZON_US / (2 * SECOND)}`,
    `1:${PUSH_HORIZON_US / (2 * SECOND)}`,
    `0:${PUSH_HORIZON_US / (2 * SECOND)}`,
    `3:${PUSH_HORIZON_US / (2 * SECOND) + 1}`,
    `1:${PUSH_HORIZON_US / (2 * SECOND) + 1}`,
    `0:${PUSH_HORIZON_US / (2 * SECOND) + 1}`,
  ]);
});

test("what isn't cut waits, and a source that found nothing hears once when it can send again", () => {
  const { q, queued } = queue(0);
  cut(q, 0);
  expect(queued.count).toBe(0);
  expect(drain(q)).toEqual(["3:0", "1:0", "0:0"]);
  cut(q, 1);
  cut(q, 2);
  q.playhead(SECOND);
  expect(queued.count).toBe(1);
  expect(drain(q)).toEqual(["3:1", "1:1", "0:1", "3:2", "1:2", "0:2"]);
});

test("a seek target's chunks go first, then chunks peers asked for, then the rest from the target", () => {
  const { q } = queue(20);
  q.request("bob", { track: 0, index: 3 });
  q.seek(21 * SECOND);
  expect(drain(q, 6)).toEqual(["3:10", "1:10", "0:10", "bob>0:3", "3:11", "1:11"]);
});

test("a chunk asked for goes to that peer even after it went live, once it is cut", () => {
  const { q } = queue(3);
  drain(q);
  q.request("bob", { track: 1, index: 0 });
  q.request("carol", { track: 0, index: 5 });
  expect(drain(q)).toEqual(["bob>1:0"]);
  for (let index = 3; index <= 5; index++) cut(q, index);
  expect(drain(q, 1)).toEqual(["carol>0:5"]);
});

test("a seek past what is cut waits for the cutting to reach it", () => {
  const { q } = queue(2);
  q.seek(30 * SECOND);
  expect(drain(q)).toEqual([]);
  for (let index = 2; index <= 14; index++) cut(q, index);
  expect(drain(q)).toEqual([]);
  cut(q, 15);
  expect(drain(q, 3)).toEqual(["3:15", "1:15", "0:15"]);
});

test("background requests go only when nothing else can", () => {
  const { q } = queue(2);
  q.request("dave", { track: 2, index: 0 }, true);
  expect(drain(q)).toEqual(["3:0", "1:0", "0:0", "3:1", "1:1", "0:1", "dave>2:0"]);
  q.request("dave", { track: 2, index: 1 }, true);
  q.request("erin", { track: 0, index: 0 });
  expect(drain(q)).toEqual(["erin>0:0", "dave>2:1"]);
});

test("an audio track selected late joins from the playhead", () => {
  const { q } = queue(6);
  q.playhead(4 * SECOND);
  drain(q);
  q.select([1, 2]);
  expect(drain(q)).toEqual(["2:2", "2:3", "2:4", "2:5"]);
});

test("requests are cancelled, dropped with their peer, queued once, and refused past the last chunk", () => {
  const { q } = queue(3);
  q.end();
  drain(q);
  q.request("bob", { track: 0, index: 1 });
  q.request("bob", { track: 0, index: 1 }, true);
  q.request("bob", { track: 0, index: 1 });
  q.request("bob", { track: 0, index: 2 });
  q.request("carol", { track: 0, index: 0 }, true);
  q.request("carol", { track: 0, index: 0 });
  q.request("dave", { track: 3, index: 2 });
  q.cancel("bob", { track: 0, index: 2 });
  q.left("dave");
  const refused = [
    q.request("bob", { track: 0, index: 3 }),
    q.request("bob", { track: 9, index: 0 }),
    q.request("bob", { track: 0, index: -1 }),
    q.request("bob", { track: 0, index: 0.5 }),
  ];
  expect(refused).toEqual([false, false, false, false]);
  expect(drain(q)).toEqual(["bob>0:1", "carol>0:0"]);
});

test("chunks of any length, from any start, are found by time", () => {
  const q = createPushQueue({ tracks: tracks.filter((t) => t.kind === "video") });
  const starts = [5, 7, 12, 13, 21];
  for (const [i, s] of starts.entries()) q.cut(s * SECOND, (starts[i + 1] ?? 30) * SECOND);
  // Before the first chunk, it covers the playhead.
  q.playhead(0);
  expect(drain(q, 1)).toEqual(["0:0"]);
  q.seek(12.5 * SECOND);
  expect(drain(q, 2)).toEqual(["0:2", "0:3"]);
  q.seek(20.9 * SECOND);
  expect(drain(q)).toEqual(["0:4"]);
});

test("past the last chunk, once every chunk is cut, the last one covers the playhead", () => {
  const { q } = queue(3);
  q.seek(60 * SECOND);
  expect(drain(q)).toEqual([]);
  q.end();
  expect(drain(q)).toEqual(["3:2", "1:2", "0:2"]);
});

test("a seek into what went live sends nothing again, and requests go next", () => {
  const { q } = queue(10);
  drain(q);
  q.request("bob", { track: 1, index: 9 });
  q.seek(4 * SECOND);
  expect(drain(q)).toEqual(["bob>1:9"]);
});

test("a deselected audio track's chunks stop", () => {
  const { q } = queue(3);
  q.select([]);
  expect(drain(q)).toEqual(["3:0", "0:0", "3:1", "0:1", "3:2", "0:2"]);
});

test("ending answers the requests queued past the last chunk", () => {
  const { q } = queue(3);
  drain(q);
  q.request("bob", { track: 0, index: 5 });
  q.request("carol", { track: 0, index: 1 });
  q.request("dave", { track: 1, index: 3 }, true);
  const gone = q.end();
  expect(gone).toEqual([
    { peer: "bob", slot: { track: 0, index: 5 } },
    { peer: "dave", slot: { track: 1, index: 3 } },
  ]);
  expect(drain(q)).toEqual(["carol>0:1"]);
});

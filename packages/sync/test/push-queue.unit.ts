// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// What the source sends next (src/push-queue.ts), in Chromium: ahead of the playhead, each index
// goes subtitles, selected audio, then video, each chunk live once and only up to the push
// horizon; what isn't cut waits; a seek target's chunks go first, then chunks peers asked for,
// then the rest ahead, and background requests only when nothing else can go; an audio track
// selected late joins from the playhead, and one deselected stops; chunks of any length are found
// by time, each with a length and starting where the last ended; and requests are cancelled,
// dropped with their peer, queued once, refused when they name no chunk, and handed back for
// `gone` once the last chunk comes before them; a repeat takes the newer priority and keeps when
// it was first asked; and at most 4 wait from each peer, an urgent one beyond them taking the place
// of the peer's newest background one, with `busy` for what has no room.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import type { Catalog } from "../src/catalog";
import type { ChunkSlot } from "../src/chunk";
import type { FetchPriority } from "../src/fetch-plan";
import { createPushQueue, PUSH_HORIZON_US, SOURCE_ROOM, type Send } from "../src/push-queue";

const tracks: Catalog["tracks"] = [
  { id: 0, kind: "video", codec: "avc1.640028", bitrateKbps: 4_800 },
  { id: 1, kind: "audio", codec: "opus", bitrateKbps: 128, language: "en" },
  { id: 2, kind: "audio", codec: "opus", bitrateKbps: 128, language: "fr" },
  { id: 3, kind: "subtitle", codec: "webvtt", bitrateKbps: 1 },
];
const SECOND = 1_000_000;

type Queue = ReturnType<typeof createPushQueue>;

// A queue with `count` chunks cut, 2 s each, English audio selected, how often it said something
// was queued, and its answers to peers, in a short spelling: `busy bob 0:1`.
function queue(count: number) {
  const queued = { count: 0 };
  const answers: string[] = [];
  const q = createPushQueue({
    tracks,
    send: (peer, { type, track, index }) => answers.push(`${type} ${peer} ${track}:${index}`),
    onQueued: () => queued.count++,
  });
  q.select([1]);
  for (let index = 0; index < count; index++) cut(q, index);
  return { q, queued, answers };
}

// Cuts the next chunk, `index`, 2 s long.
function cut(q: Queue, index: number) {
  q.cut(index * 2 * SECOND, (index + 1) * 2 * SECOND);
}

// Asks for a chunk as a peer's `request` message does.
function ask(q: Queue, peer: string, slot: ChunkSlot, priority: FetchPriority = "urgent") {
  q.requested(peer, { type: "request", ...slot, priority });
}

// Takes up to `count` sends, in a short spelling: `track:index`, or `peer>track:index`.
function drain(q: Queue, count = Infinity) {
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

test("before the first chunk is cut, nothing goes, whatever the playhead or seek target", () => {
  const { q } = queue(0);
  q.seek(5 * SECOND);
  q.playhead(SECOND);
  expect(drain(q)).toEqual([]);
  cut(q, 0);
  expect(drain(q)).toEqual(["3:0", "1:0", "0:0"]);
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
  ask(q, "bob", { track: 0, index: 3 });
  q.seek(21 * SECOND);
  expect(drain(q, 6)).toEqual(["3:10", "1:10", "0:10", "bob>0:3", "3:11", "1:11"]);
});

test("a chunk asked for goes to that peer even after it went live, once it is cut", () => {
  const { q } = queue(3);
  drain(q);
  ask(q, "bob", { track: 1, index: 0 });
  ask(q, "carol", { track: 0, index: 5 });
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
  ask(q, "dave", { track: 2, index: 0 }, "background");
  expect(drain(q)).toEqual(["3:0", "1:0", "0:0", "3:1", "1:1", "0:1", "dave>2:0"]);
  ask(q, "dave", { track: 2, index: 1 }, "background");
  ask(q, "erin", { track: 0, index: 0 });
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
  const { q, answers } = queue(3);
  q.end();
  drain(q);
  ask(q, "bob", { track: 0, index: 1 });
  ask(q, "bob", { track: 0, index: 1 }, "background");
  ask(q, "bob", { track: 0, index: 1 });
  ask(q, "bob", { track: 0, index: 2 });
  ask(q, "carol", { track: 0, index: 0 }, "background");
  ask(q, "carol", { track: 0, index: 0 });
  ask(q, "dave", { track: 3, index: 2 });
  q.requested("bob", { type: "cancel", track: 0, index: 2 });
  q.left("dave");
  ask(q, "bob", { track: 0, index: 3 });
  ask(q, "bob", { track: 9, index: 0 });
  expect(answers).toEqual(["gone bob 0:3", "gone bob 9:0"]);
  expect(drain(q)).toEqual(["bob>0:1", "carol>0:0"]);
});

test("chunks of any length, from any start, are found by time", () => {
  const q = createPushQueue({ tracks: tracks.filter((t) => t.kind === "video"), send: () => {} });
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
  ask(q, "bob", { track: 1, index: 9 });
  q.seek(4 * SECOND);
  expect(drain(q)).toEqual(["bob>1:9"]);
});

test("a deselected audio track's chunks stop", () => {
  const { q } = queue(3);
  q.select([]);
  expect(drain(q)).toEqual(["3:0", "0:0", "3:1", "0:1", "3:2", "0:2"]);
});

test("ending answers the requests queued past the last chunk", () => {
  const { q, answers } = queue(3);
  drain(q);
  ask(q, "bob", { track: 0, index: 5 });
  ask(q, "carol", { track: 0, index: 1 });
  ask(q, "dave", { track: 1, index: 3 }, "background");
  q.end();
  expect(answers).toEqual(["gone bob 0:5", "gone dave 1:3"]);
  expect(drain(q)).toEqual(["carol>0:1"]);
});

test("a chunk with no length, or that doesn't start where the last one ended, isn't cut", () => {
  const { q } = queue(2);
  expect(() => q.cut(5 * SECOND, 7 * SECOND)).toThrow(RangeError);
  expect(() => q.cut(4 * SECOND, 4 * SECOND)).toThrow(RangeError);
  expect(drain(q)).toEqual(["3:0", "1:0", "0:0", "3:1", "1:1", "0:1"]);
});

test("a repeat takes the newer priority, and keeps its place by when it was first asked", () => {
  const { q } = queue(10);
  drain(q);
  ask(q, "bob", { track: 0, index: 0 });
  ask(q, "bob", { track: 0, index: 1 }, "background");
  ask(q, "carol", { track: 0, index: 2 });
  ask(q, "bob", { track: 0, index: 3 }, "background");
  ask(q, "bob", { track: 0, index: 3 });
  // Down to the background, ahead of 1, asked after it; then 1 up, ahead of carol's 2.
  ask(q, "bob", { track: 0, index: 0 }, "background");
  ask(q, "bob", { track: 0, index: 1 });
  ask(q, "carol", { track: 0, index: 2 });
  expect(drain(q)).toEqual(["bob>0:1", "carol>0:2", "bob>0:3", "bob>0:0"]);
});

test("the source holds 4 requests from each peer, and an urgent one beyond takes a background one's place", () => {
  // The design's figure, independent of the code.
  expect(SOURCE_ROOM).toBe(4);
  const { q, answers } = queue(10);
  drain(q);
  ask(q, "bob", { track: 0, index: 0 }, "background");
  ask(q, "bob", { track: 0, index: 1 });
  ask(q, "bob", { track: 0, index: 2 });
  ask(q, "bob", { track: 0, index: 3 }, "background");
  ask(q, "bob", { track: 0, index: 4 }, "background");
  // Repeats at full room, either way, take no more room; another peer has its own.
  ask(q, "bob", { track: 0, index: 0 });
  ask(q, "bob", { track: 0, index: 3 }, "background");
  ask(q, "bob", { track: 0, index: 1 }, "background");
  ask(q, "carol", { track: 0, index: 4 });
  ask(q, "carol", { track: 0, index: 9 }, "background");
  expect(answers).toEqual(["busy bob 0:4"]);

  // Urgent requests beyond the room take the places of bob's 3, then 1, newest first, never
  // carol's; then none is left.
  ask(q, "bob", { track: 0, index: 4 });
  ask(q, "bob", { track: 0, index: 5 });
  ask(q, "bob", { track: 0, index: 6 });
  ask(q, "bob", { track: 0, index: 7 }, "background");
  expect(answers).toEqual([
    "busy bob 0:4",
    "busy bob 0:3",
    "busy bob 0:1",
    "busy bob 0:6",
    "busy bob 0:7",
  ]);

  // A chunk sent, or a request cancelled, makes room for another.
  expect(drain(q, 1)).toEqual(["bob>0:0"]);
  ask(q, "bob", { track: 0, index: 6 });
  ask(q, "bob", { track: 0, index: 7 });
  q.requested("bob", { type: "cancel", track: 0, index: 2 });
  ask(q, "bob", { track: 0, index: 7 }, "background");
  expect(answers.slice(5)).toEqual(["busy bob 0:7"]);
  expect(drain(q)).toEqual(["carol>0:4", "bob>0:4", "bob>0:5", "bob>0:6", "carol>0:9", "bob>0:7"]);
});

test("a peer's request at each priority is queued, and a busy or gone from it changes nothing", () => {
  const { q, answers, queued } = queue(3);
  q.end();
  drain(q);
  const said = queued.count;
  ask(q, "bob", { track: 0, index: 2 }, "background");
  ask(q, "bob", { track: 1, index: 0 }, "ahead");
  ask(q, "bob", { track: 3, index: 1 });
  ask(q, "bob", { track: 0, index: 0 });
  q.requested("bob", { type: "cancel", track: 3, index: 1 });
  q.requested("bob", { type: "busy", track: 0, index: 2 });
  q.requested("bob", { type: "gone", track: 0, index: 0 });
  expect(answers).toEqual([]);
  // The first request after the queue ran dry says so, once.
  expect(queued.count).toBe(said + 1);
  // `ahead` goes with those asked, `background` after them; the cancelled one is out.
  expect(drain(q)).toEqual(["bob>1:0", "bob>0:0", "bob>0:2"]);
});

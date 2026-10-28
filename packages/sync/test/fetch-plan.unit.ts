// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Where each chunk comes from (src/fetch-plan.ts), in Chromium: each chunk goes to the link
// expected to finish it first among those the tree allows, while that link has room; urgent
// chunks before the rest, in start order from the playhead, taking the place of a lower request
// on a full forwarder; `busy`, `gone`, a closed link and a late forwarder each move a chunk on as
// the design says; and a pass runs once per task and skips whole ranges. Every expected finish
// below is worked out by hand from `rtt + bytes before it and its own / throughput`.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import type { ChunkSlot } from "../src/chunk";
import { createFetchPlan, type Fetch, type LinkMeasures, type Want } from "../src/fetch-plan";

const SECOND = 1_000_000;
// Every chunk's video in these tests: 50 kB, 500 ms on a 100 B/ms link, 50 ms on a 1000 B/ms one.
const CHUNK = 50_000;

const spelled = ({ track, index }: ChunkSlot) => `${track}:${index}`;

// A plan over `count` chunks of 2 s each, with the world it reads as plain values to change.
function world(count: number) {
  const bounds = Array.from({ length: count + 1 }, (_, i) => i * 2 * SECOND);
  const at = {
    held: new Set<string>(),
    // Every index below this is held, on every track.
    heldBelow: 0,
    haves: new Map<string, Set<string>>(),
    links: new Map<string, LinkMeasures>(),
    ratios: new Map<number, number>(),
    now: 0,
    sent: [] as string[],
    reads: 0,
    misses: 0,
  };

  function missing(track: number, from: number) {
    at.misses++;
    let index = Math.max(from, at.heldBelow);
    while (at.held.has(`${track}:${index}`)) index++;
    return index;
  }

  // The lowest index at or after `from` a connected forwarder holds of `track`.
  function advertised(track: number, from: number) {
    const found: number[] = [];

    for (const [peer, has] of at.haves) {
      if (!at.links.has(peer)) continue;

      for (const key of has) {
        const [t, index] = key.split(":").map(Number);
        if (t === track && index! >= from) found.push(index!);
      }
    }

    return found.length === 0 ? undefined : Math.min(...found);
  }

  const say = (verb: string) => (f: Fetch) =>
    at.sent.push(`${verb} ${f.peer} ${spelled(f.slot)} ${f.priority}`);
  const plan = createFetchPlan({
    source: "source",
    index: () => {
      at.reads++;
      return { bounds, bytes: bounds.slice(1).map(() => CHUNK) };
    },
    ended: () => true,
    ratio: (track) => at.ratios.get(track) ?? 1,
    missing,
    advertised,
    holders: (slot) =>
      [...at.haves].filter(([, has]) => has.has(spelled(slot))).map(([peer]) => peer),
    links: () => at.links,
    now: () => at.now,
    ask: say("ask"),
    cancel: say("cancel"),
  });
  return { plan, at };
}

type World = ReturnType<typeof world>;

// A connected forwarder, its measures, and the chunks it holds of track 0.
function forwarder(at: World["at"], peer: string, link: LinkMeasures, has: number[]) {
  at.links.set(peer, link);
  at.haves.set(peer, new Set(has.map((index) => `0:${index}`)));
}

// Checks what the plan sent once its pass ran, and clears it for the next look.
async function sends(at: World["at"], expected: string[]) {
  await Promise.resolve();
  expect(at.sent.splice(0)).toEqual(expected);
}

// Video only, from `fromS` to `toS` seconds.
const video = (fromS: number, toS: number, priority: Want["priority"]): Want => ({
  tracks: [0],
  fromUs: fromS * SECOND,
  toUs: toS * SECOND,
  priority,
});

// A slow link with a short round trip: 10 + 500 = 510 ms for one chunk, room for 2.
const SLOW = { rttMs: 10, bytesPerMs: 100 };
// A fast link with a longer one: 50 + 50 = 100 ms for one chunk, room for 2 (50 kB in flight).
const FAST = { rttMs: 50, bytesPerMs: 1000 };

test("each chunk goes to the forwarder that finishes it first, while it has room", async () => {
  const { plan, at } = world(10);
  forwarder(at, "a", SLOW, [0, 1, 2, 3, 4]);
  forwarder(at, "b", FAST, [0, 1, 2, 3, 4]);
  plan.want(video(0, 10, "urgent"));
  // 0: b 100 ms against a 510. 1: b 50 + 100 kB / 1000 = 150 against 510. 2: b is full, so a.
  // 3: a 10 + 100 kB / 100 = 1010. 4: both full.
  await sends(at, ["ask b 0:0 urgent", "ask b 0:1 urgent", "ask a 0:2 urgent", "ask a 0:3 urgent"]);
});

test("a link has room while the bytes asked of it are under its throughput × RTT", async () => {
  const { plan, at } = world(10);
  // 100 × 10,000 = 1 MB in flight, far past 4 chunks: the source still holds only 4.
  at.links.set("source", { rttMs: 100, bytesPerMs: 10_000 });
  plan.want(video(0, 20, "urgent"));
  await sends(
    at,
    [0, 1, 2, 3].map((i) => `ask source 0:${i} urgent`),
  );
});

test("a chunk of another track costs its bitrate's share of the video's", async () => {
  const { plan, at } = world(4);
  at.ratios.set(1, 0.01);
  forwarder(at, "a", SLOW, []);
  forwarder(at, "b", { rttMs: 200, bytesPerMs: 1000 }, []);
  for (const has of at.haves.values()) for (const key of ["0:0", "1:0"]) has.add(key);
  plan.want({ tracks: [0, 1], fromUs: 0, toUs: 2 * SECOND, priority: "urgent" });
  // Video, 50 kB: a 510 ms, b 250. Audio, 500 B: a 10 + 5 = 15, b 200 + 50.5 kB / 1000 = 250.5.
  await sends(at, ["ask b 0:0 urgent", "ask a 1:0 urgent"]);
});

test("a link's finish counts what goes before the chunk: started, or as urgent and asked earlier", async () => {
  const { plan, at } = world(4);
  // Alone, a finishes a chunk in 30 + 250 = 280 ms and b in 200 + 50 = 250.
  forwarder(at, "a", { rttMs: 30, bytesPerMs: 200 }, [0]);
  forwarder(at, "b", { rttMs: 200, bytesPerMs: 1000 }, [0, 1]);
  plan.want(video(2, 4, "ahead"));
  await sends(at, ["ask b 0:1 ahead"]);

  // b's chunk ahead, asked earlier but less urgent, goes after an urgent one: b still 250.
  const urgent = plan.want(video(0, 2, "urgent"));
  await sends(at, ["ask b 0:0 urgent"]);
  urgent.release();
  await sends(at, ["cancel b 0:0 urgent"]);

  // Once chunk 1 is on the wire, its other 49 kB go first: b 200 + 99 = 299, so a. A piece
  // from a, which wasn't asked for it, counts for nothing.
  plan.piece({ track: 0, index: 1 }, "a", 49_000);
  plan.piece({ track: 0, index: 1 }, "b", 1000);
  const again = plan.want(video(0, 2, "urgent"));
  await sends(at, ["ask a 0:0 urgent"]);
  again.release();
  await sends(at, ["cancel a 0:0 urgent"]);

  // With 45 kB of it arrived, b has 5 kB to go first: 200 + 55 = 255, so b.
  plan.piece({ track: 0, index: 1 }, "b", 44_000);
  plan.want(video(0, 2, "urgent"));
  await sends(at, ["ask b 0:0 urgent"]);
});

test("a request is judged late only by what was asked before it", async () => {
  const { plan, at } = world(10);
  forwarder(at, "a", SLOW, [1, 2]);
  at.links.set("source", { rttMs: 20, bytesPerMs: 10_000 });
  plan.playhead(1.4 * SECOND, 0, true);
  plan.want(video(2, 6, "urgent"));
  await sends(at, ["ask a 0:1 urgent", "ask a 0:2 urgent"]);
  // Chunk 1 is due in 600 ms and a finishes it in 510, chunk 2 asked after it not counted.
  plan.progress();
  expect(at.sent).toEqual([]);
});

test("a chunk ahead never goes to the source, even once its only holder answered gone", async () => {
  const { plan, at } = world(4);
  at.links.set("source", FAST);
  forwarder(at, "a", SLOW, [0]);
  plan.want(video(0, 2, "ahead"));
  await sends(at, ["ask a 0:0 ahead"]);
  plan.gone("a", { track: 0, index: 0 });
  await sends(at, []);
});

test("urgent chunks fall back to the source, chunks ahead only wait", async () => {
  const { plan, at } = world(10);
  at.links.set("source", FAST);
  forwarder(at, "a", SLOW, [3]);
  plan.want(video(0, 2, "urgent"));
  plan.want(video(4, 8, "ahead"));
  // Chunk 2 is ahead and no one advertises it; chunk 3 is ahead and a holds it.
  await sends(at, ["ask source 0:0 urgent", "ask a 0:3 ahead"]);
});

test("while the source is offline, urgent chunks wait for a forwarder or its return", async () => {
  const { plan, at } = world(10);
  forwarder(at, "a", SLOW, [1]);
  plan.want(video(0, 4, "urgent"));
  await sends(at, ["ask a 0:1 urgent"]);
  at.links.set("source", FAST);
  plan.announced();
  await sends(at, ["ask source 0:0 urgent"]);
});

test("chunks go in start order from the playhead, those behind it last", async () => {
  const { plan, at } = world(6);
  at.links.set("source", { rttMs: 100, bytesPerMs: 10_000 });
  plan.playhead(7 * SECOND, 0, false);
  plan.want(video(0, 12, "urgent"));
  await sends(
    at,
    [3, 4, 5, 0].map((i) => `ask source 0:${i} urgent`),
  );
});

test("background chunks wait while anything more pressing is out, then go from the playhead", async () => {
  const { plan, at } = world(6);
  at.links.set("source", FAST);
  plan.playhead(6 * SECOND, 0, false);
  plan.want(video(6, 8, "urgent"));
  plan.want(video(0, 12, "background"));
  await sends(at, ["ask source 0:3 urgent"]);

  at.held.add("0:3");
  plan.stored({ track: 0, index: 3 }, "source");
  await sends(at, ["ask source 0:4 background", "ask source 0:5 background"]);

  at.held.add("0:4");
  plan.stored({ track: 0, index: 4 }, "source");
  await sends(at, ["ask source 0:0 background"]);
});

test("an urgent chunk takes the place of the newest unstarted lower request on a full link", async () => {
  const { plan, at } = world(10);
  forwarder(at, "a", SLOW, [0, 1, 2, 3, 4]);
  plan.want(video(4, 10, "ahead"));
  await sends(at, ["ask a 0:2 ahead", "ask a 0:3 ahead"]);

  plan.piece({ track: 0, index: 3 }, "a", 1000);
  plan.want(video(0, 2, "urgent"));
  // Chunk 3 has started, so chunk 2 gives way, and a, full again, takes nothing more.
  await sends(at, ["cancel a 0:2 ahead", "ask a 0:0 urgent"]);
});

test("a chunk turned urgent is asked of the same link again", async () => {
  const { plan, at } = world(10);
  forwarder(at, "a", SLOW, [0, 1]);
  plan.want(video(0, 4, "ahead"));
  await sends(at, ["ask a 0:0 ahead", "ask a 0:1 ahead"]);
  plan.want(video(0, 2, "urgent"));
  await sends(at, ["ask a 0:0 urgent"]);
});

test("busy ends a request, and the link gains room again only with its next delivery", async () => {
  const { plan, at } = world(10);
  forwarder(at, "a", FAST, [0, 1, 2, 3]);
  plan.want(video(0, 8, "ahead"));
  await sends(at, ["ask a 0:0 ahead", "ask a 0:1 ahead"]);

  plan.busy("a", { track: 0, index: 1 });
  await sends(at, []);

  at.held.add("0:0");
  plan.stored({ track: 0, index: 0 }, "a");
  await sends(at, ["ask a 0:1 ahead", "ask a 0:2 ahead"]);
});

test("busy from one forwarder sends the chunk to another that holds it", async () => {
  const { plan, at } = world(10);
  forwarder(at, "a", FAST, [0]);
  forwarder(at, "b", SLOW, [0]);
  plan.want(video(0, 2, "ahead"));
  await sends(at, ["ask a 0:0 ahead"]);
  plan.busy("a", { track: 0, index: 0 });
  await sends(at, ["ask b 0:0 ahead"]);
});

test("gone moves a chunk on without that forwarder, until it is heard from again", async () => {
  const { plan, at } = world(10);
  at.links.set("source", { rttMs: 1000, bytesPerMs: 1000 });
  forwarder(at, "a", FAST, [0]);
  forwarder(at, "b", SLOW, [0]);
  plan.want(video(0, 2, "urgent"));
  await sends(at, ["ask a 0:0 urgent"]);
  plan.gone("a", { track: 0, index: 0 });
  await sends(at, ["ask b 0:0 urgent"]);
  plan.gone("b", { track: 0, index: 0 });
  await sends(at, ["ask source 0:0 urgent"]);

  plan.closed("source");
  at.links.delete("source");
  plan.heard("b");
  await sends(at, ["ask b 0:0 urgent"]);
});

test("gone from the source leaves a chunk out until a forwarder lists it, or it announces", async () => {
  const { plan, at } = world(10);
  at.links.set("source", FAST);
  plan.want(video(0, 2, "urgent"));
  await sends(at, ["ask source 0:0 urgent"]);
  plan.gone("source", { track: 0, index: 0 });
  await sends(at, []);

  forwarder(at, "c", SLOW, [0]);
  plan.heard("c");
  await sends(at, ["ask c 0:0 urgent"]);
  plan.gone("c", { track: 0, index: 0 });
  await sends(at, []);
  plan.announced();
  await sends(at, ["ask source 0:0 urgent"]);
});

test("a closed link's requests go back into the plan, uncancelled", async () => {
  const { plan, at } = world(10);
  at.links.set("source", { rttMs: 1000, bytesPerMs: 1000 });
  forwarder(at, "a", FAST, [0, 1]);
  plan.want(video(0, 2, "urgent"));
  plan.want(video(2, 4, "ahead"));
  await sends(at, ["ask a 0:0 urgent", "ask a 0:1 ahead"]);
  at.links.delete("a");
  plan.closed("a");
  await sends(at, ["ask source 0:0 urgent"]);
});

test("an urgent request a forwarder would bring past its deadline goes to the source", async () => {
  const { plan, at } = world(10);
  forwarder(at, "a", SLOW, [0, 1, 2, 3]);
  at.links.set("source", { rttMs: 20, bytesPerMs: 10_000 });
  plan.playhead(0, 0, true);
  plan.want(video(0, 2, "urgent"));
  plan.want(video(6, 8, "urgent"));
  await sends(at, ["ask a 0:0 urgent", "ask a 0:3 urgent"]);

  at.now = 100;
  plan.progress();
  // Chunk 0 holds the playhead, due at 100 ms; a finishes it in 510, the source in 20 + 5 = 25.
  // Chunk 3 is due 5.9 s from now, well after a's 510 ms once chunk 0 has left it.
  expect(at.sent.splice(0)).toEqual(["cancel a 0:0 urgent", "ask source 0:0 urgent"]);
});

test("a late request stays where it is once started, while paused, or if the source is slower", async () => {
  const { plan, at } = world(10);
  forwarder(at, "a", SLOW, [0, 1]);
  at.links.set("source", { rttMs: 20, bytesPerMs: 10_000 });
  plan.want(video(0, 4, "urgent"));
  await sends(at, ["ask a 0:0 urgent", "ask a 0:1 urgent"]);

  // Paused: chunk 0 would otherwise be due now, and the source finish it in 25 ms against 510.
  plan.progress();
  expect(at.sent).toEqual([]);

  plan.playhead(0, 0, true);
  at.now = 1500;
  plan.piece({ track: 0, index: 0 }, "a", 1000);
  // Chunk 1 is due at 2000 ms; a has 49 kB of chunk 0 on the wire before it, so it finishes at
  // 1500 + 10 + 99 kB / 100 = 2500, and a 2-second source at 1500 + 2005 = 3505.
  at.links.set("source", { rttMs: 2000, bytesPerMs: 10_000 });
  plan.progress();
  expect(at.sent).toEqual([]);
  // The source, back to 20 ms, finishes chunk 1 at 1525, before a.
  at.links.set("source", { rttMs: 20, bytesPerMs: 10_000 });
  plan.progress();
  expect(at.sent).toEqual(["cancel a 0:1 urgent", "ask source 0:1 urgent"]);
});

test("a chunk no interest covers, or that came another way, is cancelled", async () => {
  const { plan, at } = world(10);
  forwarder(at, "a", FAST, [0, 1, 2, 3, 4, 5]);
  const interest = plan.want(video(0, 4, "ahead"));
  await sends(at, ["ask a 0:0 ahead", "ask a 0:1 ahead"]);

  at.reads = 0;
  interest.move(SECOND, 3 * SECOND);
  await sends(at, []);
  // The move read the index once, to find it covers the same chunks, and no pass ran.
  expect(at.reads).toBe(1);

  interest.move(4 * SECOND, 8 * SECOND);
  await sends(at, [
    "cancel a 0:0 ahead",
    "cancel a 0:1 ahead",
    "ask a 0:2 ahead",
    "ask a 0:3 ahead",
  ]);

  at.held.add("0:2");
  plan.stored({ track: 0, index: 2 });
  await sends(at, ["cancel a 0:2 ahead"]);
  interest.release();
  await sends(at, ["cancel a 0:3 ahead"]);
});

test("nothing is placed while storage is full", async () => {
  const { plan, at } = world(10);
  at.links.set("source", FAST);
  plan.storage(true);
  plan.want(video(0, 2, "urgent"));
  await sends(at, []);
  plan.storage(false);
  await sends(at, ["ask source 0:0 urgent"]);
});

test("events in one task are planned in one pass", async () => {
  const { plan, at } = world(10);
  at.links.set("source", FAST);
  plan.want(video(0, 2, "urgent"));
  plan.heard("source");
  plan.indexed();
  plan.announced();
  await sends(at, ["ask source 0:0 urgent"]);
  expect(at.reads).toBe(1);
});

test("a pass skips whole ranges held or advertised by no one", async () => {
  const { plan, at } = world(10_000);
  at.links.set("source", FAST);
  at.heldBelow = 9998;
  plan.want(video(0, 20_000, "background"));
  await sends(at, ["ask source 0:9998 background", "ask source 0:9999 background"]);
  // One look from 0, one at each of the 2 chunks taken, and one past the last.
  expect(at.misses).toBeLessThan(7);

  const other = world(10_000);
  other.at.links.set("source", FAST);
  forwarder(other.at, "a", FAST, [9000]);
  other.plan.want(video(0, 20_000, "ahead"));
  await sends(other.at, ["ask a 0:9000 ahead"]);
  expect(other.at.misses).toBeLessThan(7);
});

test("a pass stops once no link has room", async () => {
  const { plan, at } = world(10_000);
  at.links.set("source", FAST);
  plan.want(video(0, 20_000, "background"));
  await sends(at, ["ask source 0:0 background", "ask source 0:1 background"]);
  // One look at each chunk taken, and one at the next, which finds the link full.
  expect(at.misses).toBeLessThan(4);
});

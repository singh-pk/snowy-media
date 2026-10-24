// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Have ranges (src/have.ts), in Chromium: indexes become the fewest ranges; sealed ranges open
// as they were sent, only under their peer's key; ranges that aren't in order, apart, within the
// indexes a chunk can have, or once per track are refused, as a message or an object; a
// forwarder publishes once the stream accepts it and a burst of changes as one update; and a
// peer keeps each forwarder's newest ranges, finds who holds a chunk, and forgets a forwarder.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { contentKey, generateKeyPair, keyId, seal } from "../src/crypto";
import {
  checkHave,
  checkHaveControl,
  createHavePublisher,
  createHaves,
  InvalidHaveError,
  openHave,
  rangesOf,
  sealHave,
  type Have,
  type TrackRanges,
} from "../src/have";
import { rejection } from "./support/rejection";

const session = await generateKeyPair();
const sessionId = await keyId(session.publicKey);
const content = await contentKey(crypto.getRandomValues(new Uint8Array(32)), sessionId);
const [peer = "", other = ""] = await Promise.all(
  [1, 2].map(async () => {
    const pair = await generateKeyPair();
    return keyId(pair.publicKey);
  }),
);

const have: Have = {
  n: 3,
  tracks: [
    { track: 0, ranges: [[0, 40]] },
    {
      track: 1,
      ranges: [
        [0, 40],
        [60, 61],
      ],
    },
  ],
};

test("indexes become the fewest ranges, in order", () => {
  expect(rangesOf([5, 1, 2, 3, 3, 9, 10, 7])).toEqual([
    [1, 4],
    [5, 6],
    [7, 8],
    [9, 11],
  ]);
  expect(rangesOf([])).toEqual([]);
});

test("sealed ranges open as they were sent, only under their peer's key", async () => {
  const object = await sealHave(content, peer, have);
  expect(object.key).toBe(`have/${peer}@3`);
  const opened = await openHave(content, peer, object);
  expect(opened).toEqual(have);

  const garbage = await seal(content, `have/${peer}@4`, new TextEncoder().encode("[{]"));
  const errors = await Promise.all([
    rejection(openHave(content, other, object)),
    rejection(openHave(content, peer, { key: `have/${peer}@0`, sealed: object.sealed })),
    rejection(openHave(content, peer, { key: `have/${peer}@NaN`, sealed: object.sealed })),
    rejection(openHave(content, peer, { key: `have/${peer}@03`, sealed: object.sealed })),
    rejection(openHave(content, peer, { key: `have/${peer}@4`, sealed: object.sealed })),
    rejection(openHave(content, peer, { key: `have/${peer}@4`, sealed: garbage })),
  ]);
  expect(errors).toEqual([
    new InvalidHaveError(`not ${other}'s have: have/${peer}@3`),
    new InvalidHaveError(`not ${peer}'s have: have/${peer}@0`),
    new InvalidHaveError(`not ${peer}'s have: have/${peer}@NaN`),
    new InvalidHaveError(`not ${peer}'s have: have/${peer}@03`),
    new InvalidHaveError("doesn't open"),
    new InvalidHaveError("malformed"),
  ]);
});

// Ranges at update 1 with these entries.
const tracks = (...entries: unknown[]) => ({ n: 1, tracks: entries });

test("ranges out of order, touching, empty, past the last index, or a track twice are refused", () => {
  const bad = [
    { n: 0, tracks: [] },
    { n: 1, tracks: [], extra: 1 },
    tracks({ track: 0, ranges: [] }),
    tracks({ track: 0, ranges: [[5, 5]] }),
    tracks({
      track: 0,
      ranges: [
        [5, 9],
        [1, 2],
      ],
    }),
    tracks({
      track: 0,
      ranges: [
        [1, 5],
        [5, 9],
      ],
    }),
    tracks({ track: 0, ranges: [[0, 0x1_0000_0001]] }),
    tracks({ track: 0x1_0000, ranges: [[0, 1]] }),
    tracks({ track: 0, ranges: [[-1, 2]] }),
    tracks({ track: 0, ranges: [[0, 1.5]] }),
    tracks({ track: 0, ranges: [[0, 1, 2]] }),
    tracks({ track: 0, ranges: [], extra: 1 }),
    tracks({ track: 1, ranges: [[0, 1]] }, { track: 1, ranges: [[2, 3]] }),
    tracks({ track: 2, ranges: [[0, 1]] }, { track: 1, ranges: [[0, 1]] }),
  ];
  expect(bad.map(checkHave)).toEqual(bad.map(() => undefined));
  expect(checkHave(tracks({ track: 0, ranges: [[0, 0x1_0000_0000]] }))).toEqual({
    n: 1,
    tracks: [{ track: 0, ranges: [[0, 0x1_0000_0000]] }],
  });
  expect(checkHaveControl({ type: "have", ...have })).toEqual({ type: "have", ...have });
  expect(checkHaveControl({ type: "chat-gone", ...have })).toBeUndefined();
  expect(checkHaveControl({ type: "have", n: 1 })).toBeUndefined();
});

test("a forwarder publishes once the stream accepts it, and a burst of changes as one update", () => {
  const holding: TrackRanges[] = [{ track: 0, ranges: [[0, 1]] }];
  const sent: Have[] = [];
  const before = Date.now();
  const publisher = createHavePublisher({
    tracks: () => holding.map((t) => ({ ...t, ranges: [...t.ranges] })),
    send: (h) => sent.push(h),
  });
  expect(sent).toEqual([]);
  // The first goes with no change: what the forwarder holds on connecting.
  publisher.writable();
  expect(sent).toEqual([{ n: sent[0]?.n, tracks: [{ track: 0, ranges: [[0, 1]] }] }]);
  const first = sent[0]?.n ?? 0;
  expect(first).toBeGreaterThan(before);

  // Stores while the stream is busy become one update.
  holding[0] = { track: 0, ranges: [[0, 2]] };
  publisher.changed();
  holding[0] = { track: 0, ranges: [[0, 3]] };
  publisher.changed();
  expect(sent.length).toBe(1);
  publisher.writable();
  expect(sent.at(-1)).toEqual({ n: first + 1, tracks: [{ track: 0, ranges: [[0, 3]] }] });

  // Nothing changed: the stream being free sends nothing, and the next change goes at once.
  publisher.writable();
  expect(sent.length).toBe(2);
  publisher.changed();
  expect(sent.at(-1)?.n).toBe(first + 2);

  // A publisher made later, as after a reload, numbers from the time it was made.
  const again: Have[] = [];
  const later = createHavePublisher({ tracks: () => [], send: (h) => again.push(h) });
  later.writable();
  expect(again[0]?.n ?? 0).toBeGreaterThan(before);
});

test("a peer keeps each forwarder's newest ranges, finds who holds a chunk, and forgets a forwarder", () => {
  const haves = createHaves();
  const older: Have = { n: 2, tracks: [{ track: 0, ranges: [[0, 100]] }] };
  expect(haves.receive(peer, have)).toBe(true);
  expect(haves.receive(peer, older)).toBe(false);
  expect(haves.receive(peer, have)).toBe(false);
  expect(haves.receive(other, older)).toBe(true);
  expect(haves.holders({ track: 0, index: 50 })).toEqual([other]);
  expect(haves.holders({ track: 1, index: 60 })).toEqual([peer]);
  expect(haves.holders({ track: 0, index: 39 })).toEqual([peer, other]);
  expect(haves.holders({ track: 1, index: 61 })).toEqual([]);

  // A forwarder that reconnects counts from 1 again, once forgotten.
  haves.forget(peer);
  expect(haves.holders({ track: 1, index: 60 })).toEqual([]);
  expect(haves.receive(peer, { n: 1, tracks: [{ track: 1, ranges: [[60, 61]] }] })).toBe(true);
  expect(haves.holders({ track: 1, index: 60 })).toEqual([peer]);
});

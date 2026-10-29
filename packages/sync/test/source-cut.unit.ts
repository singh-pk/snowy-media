// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The source's cut of its file (src/source-cut.ts), in Chromium: every chunk is signed once and
// its header kept, with its sealed size, and an index is reported only once every track's chunk
// of it is kept, so each can be cut again from its header; a cut that stops carries on after a
// reload from what is kept, signing nothing again; and a file with no keyframe, or none where
// cutting carries on from, cuts nothing.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { chunkKey, chunkStartUs, HEADER, openChunk, type ChunkSlot } from "../src/chunk";
import { recutChunk } from "../src/chunk-recut";
import { contentKey, generateKeyPair, keyId } from "../src/crypto";
import { cutSource, type KeptChunk, type SourceCutOptions } from "../src/source-cut";
import { at, AUDIO, demuxer, file, S, VIDEO, type Read } from "./support/demuxed";
import { rejection } from "./support/rejection";

const pair = await generateKeyPair();
const sessionId = await keyId(pair.publicKey);
const content = await contentKey(crypto.getRandomValues(new Uint8Array(32)), sessionId);

// The file's six indexes, as its keyframes bound them: [0, 3), [3, 6) … [15, 18.14) s.
const bounds = [0, 3, 6, 9, 12, 15, 18.14].map((s) => Math.round(s * S));

// A source's store, and a log of what it keeps and reports, in order.
function source(packets: readonly Read[] = file, held = new Map<string, KeptChunk>()) {
  const log: string[] = [];
  const { read, seen } = demuxer(packets);
  const options: SourceCutOptions = {
    session: pair,
    video: VIDEO,
    tracks: [AUDIO],
    read,
    kept: (slot) => held.get(chunkKey(slot)),
    keep: async (slot, chunk) => {
      held.set(chunkKey(slot), chunk);
      log.push(`keep ${chunkKey(slot)}`);
    },
    indexed: ({ index, startUs, endUs }) => log.push(`index ${index} ${startUs}-${endUs}`),
  };
  return { options, held, log, seen };
}

const recut = (held: Map<string, KeptChunk>, slot: ChunkSlot) =>
  recutChunk(
    {
      video: VIDEO,
      tracks: [AUDIO],
      content,
      header: (s) => held.get(chunkKey(s))?.header,
      read: demuxer(file).read,
    },
    slot,
  );

// `read`, failing with `error` at the video packet at `ptsUs`.
function failingAt(read: SourceCutOptions["read"], ptsUs: number, error: Error) {
  return async function* (fromUs: number | undefined) {
    for await (const next of read(fromUs)) {
      if (next[0] === VIDEO && next[1].ptsUs === ptsUs) throw error;
      yield next;
    }
  };
}

test("an index is reported once every track's chunk of it is kept", async () => {
  const { options, log } = source();
  const count = await cutSource(options);

  expect(count).toBe(6);
  expect(log.slice(0, 6)).toEqual([
    "keep media/0/0",
    "keep media/0/1",
    "keep media/1/0",
    `index 0 0-${3 * S}`,
    "keep media/0/2",
    "keep media/1/1",
  ]);
  expect(log.filter((l) => l.startsWith("index"))).toEqual(
    bounds.slice(0, -1).map((b, i) => `index ${i} ${b}-${bounds[i + 1]}`),
  );
  expect(log.filter((l) => l.startsWith("keep"))).toHaveLength(12);
});

test("each header kept cuts its chunk again, at the sealed size kept and reported", async () => {
  const sizes: number[] = [];
  const { options, held } = source();
  options.indexed = ({ bytes }) => sizes.push(bytes);
  await cutSource(options);

  for (const [key, kept] of held) {
    const [, track, index] = key.split("/").map(Number);
    const slot = { track: track!, index: index! };
    const sealed = await recut(held, slot);
    const chunk = await openChunk(pair.publicKey, content, { key, sealed: sealed! });

    expect(kept.header.byteLength).toBe(HEADER);
    expect(sealed!.byteLength).toBe(kept.bytes);
    expect(chunk.startUs).toBe(bounds[index!]);
  }

  const video = [0, 1, 2, 3, 4, 5].map((index) => held.get(`media/0/${index}`)!.bytes);
  expect(sizes).toEqual(video);
});

test("a cut that stops carries on from what is kept, signing nothing again", async () => {
  const whole = source();
  await cutSource(whole.options);

  // Reading fails partway, at the video keyframe at 10.5 s, after the one at 9 s closed video 2.
  const failing = source();
  const stop = new Error("the file couldn't be read");
  failing.options.read = failingAt(demuxer(file).read, 10.5 * S, stop);
  const error = await rejection(cutSource(failing.options));

  // Index 1 is the last every track's chunk of which is kept; video 2 is kept too.
  expect(error).toBe(stop);
  expect([...failing.held.keys()]).toEqual([
    "media/0/0",
    "media/0/1",
    "media/1/0",
    "media/0/2",
    "media/1/1",
  ]);

  const resumed = source(file, failing.held);
  const startUs = chunkStartUs(failing.held.get("media/0/1")!.header);
  resumed.options.from = { index: 1, startUs };
  const count = await cutSource(resumed.options);

  expect(count).toBe(6);
  expect(resumed.seen.from).toEqual([3 * S]);
  expect(resumed.log.filter((l) => l.startsWith("keep"))).toEqual([
    "keep media/0/3",
    "keep media/1/2",
    "keep media/0/4",
    "keep media/1/3",
    "keep media/0/5",
    "keep media/1/4",
    "keep media/1/5",
  ]);
  expect(resumed.log.filter((l) => l.startsWith("index")).map((l) => l.split(" ")[1])).toEqual([
    "2",
    "3",
    "4",
    "5",
  ]);
  expect(resumed.held).toEqual(whole.held);
});

test("a file of video alone reports each index once its video chunk is kept", async () => {
  const { options, log } = source([0, 2, 4].map((s): Read => [VIDEO, at(s, true)]));
  options.tracks = [];
  const count = await cutSource(options);

  expect(count).toBe(3);
  expect(log).toEqual([
    "keep media/0/0",
    "index 0 0-2000000",
    "keep media/0/1",
    "index 1 2000000-4000000",
    "keep media/0/2",
    "index 2 4000000-4040000",
  ]);
});

test("carrying on from the last index finds nothing more to cut", async () => {
  const whole = source();
  await cutSource(whole.options);
  const again = source(file, whole.held);
  again.options.from = { index: 5, startUs: 15 * S };
  const count = await cutSource(again.options);

  expect(count).toBe(6);
  expect(again.log).toEqual([]);
});

test("a file with no video keyframe, or none where cutting carries on, cuts nothing", async () => {
  const none = source(file.filter(([track]) => track === AUDIO));
  const moved = source(file.filter(([track, p]) => !(track === VIDEO && p.ptsUs === 3 * S)));
  moved.options.from = { index: 1, startUs: 3 * S };

  const results = await Promise.all([cutSource(none.options), cutSource(moved.options)]);

  expect(results).toEqual([undefined, undefined]);
  expect(none.held.size).toBe(0);
  // From the keyframe at 1.5 s to the one at 4.5 s, which shows the one at 3 s is gone.
  expect(moved.seen.reads).toBe(10);
  expect(moved.held.size).toBe(0);
});

test("a cut whose keeping fails rejects with its error, reporting nothing more", async () => {
  const { options, log } = source([0, 2, 4, 6].map((s): Read => [VIDEO, at(s, true)]));
  const full = new DOMException("full", "QuotaExceededError");

  options.keep = async (slot) => {
    log.push(`keep ${chunkKey(slot)}`);
    if (slot.track === AUDIO && slot.index === 1) throw full;
  };

  const error = await rejection(cutSource(options));

  expect(error).toBe(full);
  expect(log).toEqual([
    "keep media/0/0",
    "keep media/0/1",
    "keep media/1/0",
    "index 0 0-2000000",
    "keep media/0/2",
    "keep media/1/1",
  ]);
});

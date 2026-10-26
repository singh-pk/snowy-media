// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The relay connection (src/relay.ts) against a real MoQ relay (test/support/relay.ts), in
// Chromium: admission by token, presence, links that open, carry messages and objects, and close,
// the source's records, and chat whose tracks and repairs go through the relay. Each scenario runs in a worker of its own page
// (test/support/relay-worker.ts). Needs Docker. Usage: bun run test

import { afterAll, expect, test } from "bun:test";
import { chromium } from "playwright";
import { COVERAGE, coverBrowser, wrapWorkers } from "../../../tooling/coverage";
import { serve } from "../../../tooling/test-server";
import { startRelay } from "./support/relay";
import type { RelayConfig, Scenario } from "./support/relay-worker";

const pkg = new URL("../", import.meta.url);
const WORKER = "/test/dist/relay/relay-worker.js";

const built = await Bun.build({
  entrypoints: [`${pkg.pathname}test/support/relay-worker.ts`],
  outdir: `${pkg.pathname}test/dist/relay`,
  target: "browser",
  sourcemap: "external",
});
if (!built.success) throw new AggregateError(built.logs, "the relay worker didn't build");
if (COVERAGE) await wrapWorkers([`${pkg.pathname}test/dist/relay/relay-worker.js`]);

// Each is stopped after the tests, even if starting the next one fails.
const server = serve(pkg, "<!doctype html><title>relay</title>");
afterAll(() => server.stop(true));
const launched = await chromium.launch();
const browser = coverBrowser(pkg.pathname, launched);
afterAll(() => browser.close());

// Runs a scenario in a worker of a fresh page, against a relay of its own, resolving with what
// it posted. A relay per scenario keeps one that fails from failing the next.
async function scenario(name: Scenario) {
  const relay = await startRelay();
  const tab = await browser.newPage();

  try {
    await tab.goto(server.url.href);
    const config: RelayConfig = { url: relay.url, hash: relay.hash };
    const posted = await tab.evaluate(
      async ([worker, scenarioName, relayConfig]) => {
        const running = new Worker(worker, { type: "module" });
        const { promise, resolve } = Promise.withResolvers<unknown>();
        running.addEventListener("message", ({ data }) => resolve(data));
        running.addEventListener("error", ({ message }) => resolve({ error: message }));
        running.postMessage({ scenario: scenarioName, config: relayConfig });
        return promise;
      },
      [WORKER, name, config] as const,
    );
    if (typeof posted !== "object" || posted === null) throw new Error("the worker posted nothing");
    if ("error" in posted) throw new Error(String(posted.error));
    return "result" in posted ? posted.result : undefined;
  } finally {
    try {
      await tab.close();
    } finally {
      await relay.stop();
    }
  }
}

test("each peer sees the other come online, and go", async () => {
  const result = await scenario("presence");
  expect(result).toEqual({ aliceSaw: ["announce", "unannounce"], bobSawAlice: true });
}, 60_000);

test("a link carries messages and objects, and closes when its peer leaves", async () => {
  const result = await scenario("links");
  expect(result).toMatchObject({
    heard: expect.arrayContaining([
      { to: "alice", value: expect.objectContaining({ firstSeq: 2 }) },
      { to: "bob", value: expect.objectContaining({ firstSeq: 1 }) },
    ]),
    objects: [{ text: "batch" }],
    fromBob: [true],
    closed: ["alice", "bob"],
    peers: { alice: true, bob: true },
  });
}, 60_000);

test("a peer that leaves and comes back with the same key opens a new link", async () => {
  const result = await scenario("rejoin");
  expect(result).toMatchObject({
    samePeer: true,
    heard: [expect.objectContaining({ firstSeq: 3 })],
    fromAlice: [expect.objectContaining({ firstSeq: 4 })],
  });
}, 60_000);

test("the relay refuses a subscription to a track nobody publishes", async () => {
  const result = await scenario("refused");
  expect(result).toEqual({ refused: true });
}, 60_000);

test("the relay admits a peer only with a token for its session, signed by its key", async () => {
  const result = await scenario("admission");
  expect(result).toEqual({ admitted: true, elsewhere: true, forged: true });
}, 60_000);

test("a peer can't announce itself as another", async () => {
  const result = await scenario("impostor");
  expect(result).toEqual({ sawImpostor: false, subscribeRefused: true });
}, 60_000);

test("only the source publishes `source`, and its records and chunks reach the others and check out", async () => {
  const result = await scenario("source");
  expect(result).toEqual({
    forgedRefused: true,
    rejected: [],
    catalog: {
      version: 1,
      durationUs: 10_000_000,
      tracks: [{ id: 0, kind: "video", codec: "vp09.00.10.08", bitrateKbps: 900 }],
    },
    control: { epoch: 1, playing: true, mediaUs: 0, atUs: 5, ended: false },
    setup: { track: 0, codec: "vp09.00.10.08", codedWidth: 64, codedHeight: 48 },
    chunks: [
      { index: 0, startUs: 0, endUs: 2_000_000, packets: 2 },
      { index: 1, startUs: 2_000_000, endUs: 4_000_000, packets: 2 },
    ],
  });
}, 60_000);

test("chat goes through the relay, and a late joiner catches up over a link", async () => {
  const result = await scenario("chat");
  expect(result).toEqual({ bob: ["one", "two", "three"], carol: ["one", "two", "three"] });
}, 90_000);

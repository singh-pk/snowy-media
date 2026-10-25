// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The module worker tooling/run-unit.ts starts for each unit test file, the file's bundle in
// its URL (`?file=`). Once told to start, which waits for coverage to start when it is
// collected (tooling/coverage.ts), it imports the file, which settles only once it has loaded,
// top-level awaits and all, so every test is registered, and posts their names. Then it runs
// one test each time it is asked, in the order they were registered, and posts its failures:
// an error or rejection the test leaves behind fails it too.

import { registry } from "./unit";

/** What the worker posts: the names once the file has loaded, then each test's failures. */
export type FromUnitWorker =
  | { type: "loaded"; names: string[]; error?: string }
  | { type: "ran"; index: number; failures: string[] };

const show = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e));
// What escaped since it was last reported: from the test running, or before it, in the gap
// since the one before reported. What escapes after a file's last test is not reported.
const escaped: string[] = [];

// Handled here, so a test's stray error fails that test, not the whole file.
addEventListener("error", (e) => {
  e.preventDefault();
  escaped.push(e instanceof ErrorEvent ? show(e.error ?? e.message) : e.type);
});

addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  escaped.push(e instanceof PromiseRejectionEvent ? show(e.reason) : e.type);
});

// One task, on a message rather than a timer.
async function turn() {
  const channel = new MessageChannel();
  const next = Promise.withResolvers<void>();
  channel.port1.addEventListener("message", () => next.resolve(), { once: true });
  channel.port1.start();
  channel.port2.postMessage(null);
  await next.promise;
  channel.port1.close();
}

// Runs test `index` and posts what failed: what it threw, then, two tasks on, what escaped it,
// as Chromium reports an unhandled rejection in a task of its own after the one that made it.
async function run(index: number) {
  const failures: string[] = [];

  try {
    await registry[index]?.body();
  } catch (e) {
    failures.push(show(e));
  }

  await turn();
  await turn();
  for (const e of escaped.splice(0)) failures.push(`escaped: ${e}`);
  postMessage({ type: "ran", index, failures } satisfies FromUnitWorker);
}

// The tests registered so far.
const names = () => registry.map(({ name }) => name);

// Imports the file; its own load errors count against it, not a test.
async function load() {
  const file = new URL(location.href).searchParams.get("file") ?? "";

  try {
    await import(file);
    await turn();
    await turn();
    const error = escaped.length > 0 ? { error: escaped.splice(0).join("\n") } : {};
    postMessage({ type: "loaded", names: names(), ...error } satisfies FromUnitWorker);
  } catch (e) {
    postMessage({ type: "loaded", names: names(), error: show(e) } satisfies FromUnitWorker);
  }
}

/** What the worker is sent: to start, then the index of each test to run. */
export type ToUnitWorker = "start" | number;

addEventListener("message", ({ data }: MessageEvent<ToUnitWorker>) => {
  void (data === "start" ? load() : run(data));
});

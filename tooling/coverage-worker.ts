// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Stands in for a worker's bundle `X.js` when coverage is collected (tooling/coverage.ts,
// wrapWorkers), the bundle itself moved to `X.covered.js`. Chromium runs a new worker before
// coverage can start in it, so this waits until it has, then imports the bundle; the messages
// that arrive meanwhile are held and then delivered to it, in order. Workers this one ends are
// paused on, as on the page, so their coverage is taken first.

const held: MessageEvent[] = [];

// Registered first, so no listener of the bundle's sees a message before it is delivered again.
function hold(event: MessageEvent) {
  event.stopImmediatePropagation();
  held.push(event);
}

self.addEventListener("message", hold);
self.addEventListener("messageerror", hold);

function terminate(end: Worker["terminate"], worker: Worker, args: []) {
  // oxlint-disable-next-line no-debugger -- the pause that has coverage taken before a worker ends
  debugger;
  Reflect.apply(end, worker, args);
}

// oxlint-disable-next-line typescript/unbound-method -- the platform method, wrapped in place, is called with its receiver
Worker.prototype.terminate = new Proxy(Worker.prototype.terminate, { apply: terminate });

// tooling/coverage.ts sets __snowyCovered, and calls __snowyGo if this got here first.
const go = Promise.withResolvers<void>();
Object.assign(globalThis, { __snowyGo: go.resolve });
if (!("__snowyCovered" in globalThis)) await go.promise;
// With the query, which some bundles read their arguments from.
const bundle = new URL(import.meta.url);
bundle.pathname = bundle.pathname.replace(/\.js$/, ".covered.js");

try {
  await import(bundle.href);
} finally {
  self.removeEventListener("message", hold);
  self.removeEventListener("messageerror", hold);
}

for (const event of held) {
  // copy: a message event's ports are read-only, and a new event takes an array of its own
  const ports = [...event.ports];
  self.dispatchEvent(new MessageEvent(event.type, { data: event.data, ports }));
}

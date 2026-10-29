// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// What linked peers heard from the peer under test, as events a test can wait for, with chunk
// messages in a short spelling.

import { checkChunkControl } from "../../src/chunk-requests";

export function createHearing() {
  const heard: string[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];

  function hear(event: string) {
    heard.push(event);
    for (const waiter of waiters) if (heard.length >= waiter.count) waiter.resolve();
  }

  // Resolves once `count` events have been heard in all.
  function until(count: number) {
    const { promise, resolve } = Promise.withResolvers<void>();
    waiters.push({ count, resolve });
    if (heard.length >= count) resolve();
    return promise;
  }

  return { heard, hear, until };
}

/** A chunk message in a short spelling: `request 0:1 urgent`, `gone 0:5`. */
export function spell(value: unknown) {
  const message = checkChunkControl(value)!;
  const priority = message.type === "request" ? ` ${message.priority}` : "";
  return `${message.type} ${message.track}:${message.index}${priority}`;
}

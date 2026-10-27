// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Waiting on events in the relay tests' scenarios, instead of on time.

// Checks that resolve once they hold, looked at again on each `changed()`.
export function watch() {
  const waiting: Array<{ check: () => boolean; resolve: () => void }> = [];

  function changed() {
    for (const wait of waiting.filter((w) => w.check())) {
      waiting.splice(waiting.indexOf(wait), 1);
      wait.resolve();
    }
  }

  async function until(check: () => boolean) {
    if (check()) return;

    const { promise, resolve } = Promise.withResolvers<void>();
    waiting.push({ check, resolve });
    await promise;
  }

  return { changed, until };
}

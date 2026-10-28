// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Calls that run one at a time, in the order they are made, which a history and the branches
// need so that an entry arriving twice at once is applied once.

// Waits for a call that came before, whatever it did: its caller has its error.
async function settledOf(previous: Promise<unknown>) {
  try {
    await previous;
  } catch {
    // Reported to that call's caller.
  }
}

async function afterSettled<T>(previous: Promise<unknown>, work: () => Promise<T>) {
  await settledOf(previous);
  return work();
}

/** A function that runs `work` once every call to it before has finished. */
export function createSerial() {
  let last: Promise<unknown> = Promise.resolve();

  return function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = afterSettled(last, work);
    last = run;
    return run;
  };
}

/** `call` on `state`, run through `serial`: once every call to `serial` before has finished. */
export function queued<S, A extends unknown[], T>(
  serial: ReturnType<typeof createSerial>,
  state: S,
  call: (state: S, ...args: A) => Promise<T>,
) {
  return (...args: A) => serial(() => call(state, ...args));
}

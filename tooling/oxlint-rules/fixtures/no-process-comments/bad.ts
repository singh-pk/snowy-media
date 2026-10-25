// expected lines: 2 3 4 5 6 7 8 9 10 11
// TODO: split this
// Keeps the old value for now.
// Phase 2 moves this to the worker.
// As requested, the cache is gone.
// We changed the order to fix the race.
// Written by Claude.
/* The old code copied the buffer. */
// fixed: the race on close
// The next PR moves this to the worker.
// This flag is no longer needed.
export const x = 1;

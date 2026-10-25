// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The hybrid logical clock that orders chat (docs/architecture.md#order): 16 hex digits, the
// wall clock in ms (48 bits) then a counter (16 bits), so comparing two as strings compares
// them as numbers. It moves forward on every message sent and received, so a reply always
// sorts after what it answers, whatever the two wall clocks say.

const WALL_DIGITS = 12;
const COUNTER_DIGITS = 4;
const COUNTER_MAX = 0xffff;
const WALL_MAX = 2 ** 48 - 1;
const FORMAT = /^[0-9a-f]{16}$/;
/** A received clock further ahead of the local wall clock than this doesn't move the clock. */
export const MAX_AHEAD_MS = 60_000;

/** A hybrid logical clock value: 16 lowercase hex digits. */
export type Hlc = string;

type Parts = { wall: number; counter: number };

export const isHlc = (value: unknown): value is Hlc =>
  typeof value === "string" && FORMAT.test(value);

function parse(hlc: string): Parts {
  if (!FORMAT.test(hlc)) throw new RangeError(`not a clock value: ${hlc}`);
  return {
    wall: Number.parseInt(hlc.substring(0, WALL_DIGITS), 16),
    counter: Number.parseInt(hlc.substring(WALL_DIGITS), 16),
  };
}

function format({ wall, counter }: Parts): Hlc {
  if (wall > WALL_MAX) throw new RangeError(`wall clock past 48 bits: ${wall}`);
  return (
    wall.toString(16).padStart(WALL_DIGITS, "0") +
    counter.toString(16).padStart(COUNTER_DIGITS, "0")
  );
}

// Whole ms, whatever clock `now` reads.
const wallTime = (now: () => number) => Math.floor(now());

// A counter past 16 bits carries into the wall clock instead of wrapping, so the clock never
// goes back.
const carried = ({ wall, counter }: Parts): Parts =>
  counter > COUNTER_MAX ? { wall: wall + 1, counter: 0 } : { wall, counter };

/**
 * A peer's clock. `now` reads the wall clock in ms; `last` is the value stored before a
 * reload, so the clock never goes back across one, even if the wall clock did.
 */
export function createClock(now: () => number = Date.now, last?: Hlc) {
  let state: Parts = last === undefined ? { wall: 0, counter: 0 } : parse(last);

  /** The value for a message about to be sent. */
  function send() {
    const wall = wallTime(now);
    state =
      wall > state.wall
        ? { wall, counter: 0 }
        : carried({ wall: state.wall, counter: state.counter + 1 });
    return format(state);
  }

  /**
   * Moves the clock past a received message's. One from more than `MAX_AHEAD_MS` ahead is
   * ignored, so a peer with a wrong clock, or a hostile one, can't drag everyone's forward.
   */
  function receive(hlc: Hlc) {
    const remote = parse(hlc);
    const wall = wallTime(now);
    if (remote.wall > wall + MAX_AHEAD_MS) return;

    const next = Math.max(state.wall, remote.wall, wall);
    const counter =
      next === state.wall && next === remote.wall
        ? Math.max(state.counter, remote.counter) + 1
        : next === state.wall
          ? state.counter + 1
          : next === remote.wall
            ? remote.counter + 1
            : 0;
    state = carried({ wall: next, counter });
  }

  /** The current value, to store for the next `createClock`. */
  const value = () => format(state);

  return { send, receive, value };
}

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Getting the session's state on join (docs/architecture.md#presence-and-membership): the relay
// holds none, so a joiner asks one peer for the source's records, sent with a link's `send`. It
// asks the source if it's online, otherwise the online peer with the lowest
// `SHA-256(peer ‖ "state")`. The responder delivers every record it holds, unchanged, through the
// link's `deliver`, and says how many with `state-sent`; or it answers `state-gone` if it doesn't
// hold the whole state. The joiner asks the next peer on `state-gone`, on a record that doesn't
// check out, once a peer's records have all come and still leave it short, or when that peer's
// link closes. Every record is signed, so it can come from any peer. Everything moves on events:
// there is no timeout, since a link that dies closes.

import { isCount, isRecord } from "./chat";
import type { Bytes, KeyId } from "./crypto";
import { rank } from "./rank";
import { isSourceKey, type createSourceRecords } from "./source-records";

type Records = ReturnType<typeof createSourceRecords>;

/** Asks for the source's records. `ask` counts up with each request, and answers name it. */
type StateRequest = { type: "state-request"; ask: number };
/** The responder doesn't hold the whole state. */
type StateGone = { type: "state-gone"; ask: number };
/** The responder has delivered `count` records. */
type StateSent = { type: "state-sent"; ask: number; count: number };

export type StateControl = StateRequest | StateGone | StateSent;
type StateAnswer = StateGone | StateSent;

/** A state message received from a peer, checked, or undefined for anything else. */
export function checkStateControl(value: unknown): StateControl | undefined {
  if (!isRecord(value)) return undefined;

  const { type, ask, count } = value;
  if (!isCount(ask, 1)) return undefined;
  if (type === "state-request" || type === "state-gone") return { type, ask };
  if (type === "state-sent" && isCount(count, 1)) return { type, ask, count };
  return undefined;
}

export type StateResponderOptions = {
  records: Records;
  /** Sends a message to a peer over its link. */
  send(peer: KeyId, message: StateAnswer): void;
  /** Sends an object to a peer that asked for it, on its `deliver` track. */
  deliver(peer: KeyId, key: string, bytes: Bytes): void;
};

/** Answers other peers' `state-request` from the records this peer holds. */
export function createStateResponder(options: StateResponderOptions) {
  const { records } = options;

  /** Answers a `state-request` from `peer`. */
  function requested(peer: KeyId, { ask }: StateRequest) {
    if (!records.complete()) {
      options.send(peer, { type: "state-gone", ask });
      return;
    }

    const objects = records.objects();
    for (const { key, sealed } of objects) options.deliver(peer, key, sealed);
    options.send(peer, { type: "state-sent", ask, count: objects.length });
  }

  return { requested };
}

export type StateAskOptions = {
  records: Records;
  /** Sends a message to a peer over its link. */
  send(peer: KeyId, message: StateRequest): void;
  /** Whether this peer's link to `peer` is open: one that closed while ranking isn't asked. */
  linked(peer: KeyId): boolean;
};

/** Asks one peer at a time for the source's records, until this peer holds the whole state. */
export function createStateAsk(options: StateAskOptions) {
  const { records } = options;
  const ask = {
    candidates: [] as KeyId[],
    asked: -1,
    /** The number of the latest request, which answers name. */
    request: 0,
    /** Records the asked peer has delivered, and how many it said it sent. */
    delivered: 0,
    sent: undefined as number | undefined,
    /** The number of the latest `start`: an earlier one that finishes ranking later is dropped. */
    starts: 0,
  };

  // The peer asked now, if an ask is waiting on one.
  const waiting = () => ask.candidates[ask.asked];

  // Asks the next candidate whose link is open, unless the whole state is held: then, or once no
  // candidate is left, the ask ends.
  function next() {
    const open = ask.candidates.findIndex((c, i) => i > ask.asked && options.linked(c));
    ask.asked = open === -1 ? ask.candidates.length : open;
    const peer = waiting();

    if (peer === undefined || records.complete()) {
      ask.candidates = [];
      return;
    }

    ask.request++;
    ask.delivered = 0;
    ask.sent = undefined;
    options.send(peer, { type: "state-request", ask: ask.request });
  }

  // Moves on once the asked peer's records have all come and the state is still short. A record
  // of an earlier request to the same peer, coming late, may be counted, which at worst moves on
  // early.
  function check() {
    if (records.complete()) {
      ask.candidates = [];
      return;
    }

    if (ask.sent !== undefined && ask.delivered >= ask.sent) next();
  }

  /**
   * Asks for the state, unless it is held: the source first if it is one of the online
   * `candidates`, then the rest by rank. Called on join and as peers come online. During an ask,
   * the candidates not yet asked become these, so a peer that came online is asked in its turn,
   * the source next; an ask that ran out of candidates ended, and starts again, asking peers that
   * failed before, since they may hold more by now.
   */
  async function start(candidates: KeyId[], source?: KeyId) {
    if (records.complete()) return;
    ask.starts++;
    const call = ask.starts;
    const ranked = await rank(
      candidates.filter((c) => c !== source),
      "state",
    );
    if (records.complete() || call !== ask.starts) return;
    if (source !== undefined && candidates.includes(source)) ranked.unshift(source);

    if (waiting() === undefined) {
      ask.candidates = ranked;
      ask.asked = -1;
      next();
      return;
    }

    // The peers asked so far stay first, in order; the rest follow as ranked now.
    ask.candidates.length = ask.asked + 1;
    for (const c of ranked) if (!ask.candidates.includes(c)) ask.candidates.push(c);
  }

  /** A `state-gone` or `state-sent` from a peer, for this peer's latest request or not. */
  function answered(peer: KeyId, answer: StateAnswer) {
    if (waiting() !== peer || answer.ask !== ask.request) return;

    if (answer.type === "state-gone") {
      next();
      return;
    }

    ask.sent = answer.count;
    check();
  }

  /** The peer's link closed, or it sent a record that doesn't check out: if the ask waits on it, ask the next. */
  function passed(peer: KeyId) {
    if (waiting() === peer) next();
  }

  /**
   * Takes an object a peer delivered. Only the source's records count: anything else, such as a
   * capability record or a chat batch, is left to whatever takes it. A record that doesn't check
   * out moves the ask on from that peer, and rejects as `records.receive` does.
   */
  async function delivered(peer: KeyId, key: string, sealed: Bytes) {
    if (!isSourceKey(key)) return;

    try {
      await records.receive({ key, sealed });
    } catch (error) {
      passed(peer);
      throw error;
    }

    if (waiting() === peer) ask.delivered++;
    if (waiting() !== undefined) check();
  }

  return { start, answered, closed: passed, delivered };
}

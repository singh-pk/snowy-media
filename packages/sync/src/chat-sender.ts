// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Sending this peer's chat (docs/architecture.md#sending). A message is chained and returned at
// once, for the local log, then queued. Whenever the stream is free, everything queued goes as
// one batch, so batching follows the network's speed rather than a clock; while the stream is
// busy or closed, messages wait in the queue.

import { encodeBatch } from "./chat-batch";
import { checkMessage, messageHash, type ChatMessage } from "./chat";
import { keyId, type Bytes } from "./crypto";
import type { Hlc } from "./hlc";

type Content = Pick<ChatMessage, "kind" | "target" | "text" | "emoji">;

export type ChatSenderOptions = {
  /** This peer's key pair: the author of every message, and the checkpoints' signer. */
  peer: CryptoKeyPair;
  content: CryptoKey;
  clock: { send(): Hlc };
  /** Writes a message to the local store; the message is queued only once it resolves. */
  keep(message: ChatMessage): unknown;
  /** The author's newest message from before a reload, to chain the next one to. */
  last?: ChatMessage | undefined;
  /**
   * The author's messages from before a reload that may not have been published, ending at
   * `last` (`unsent` in src/chat-store.ts): queued again, to go with the first batch. The
   * sender takes the array over and changes it.
   */
  pending?: ChatMessage[] | undefined;
  /**
   * Hands a batch to the stream; `writable()` is called once the stream takes more. A throw
   * keeps the batch's messages queued for then.
   */
  publish(key: string, bytes: Bytes): void;
};

// Stands in for the clock while a message is checked, so a refused one doesn't move it.
const NO_CLOCK = "0000000000000000";

const previousHash = async (last?: ChatMessage) => (last === undefined ? "" : messageHash(last));

export function createChatSender(options: ChatSenderOptions) {
  const author = keyId(options.peer.publicKey);
  const queue: ChatMessage[] = options.pending ?? [];
  const batches = createBatches(options, queue);
  const state: { last?: ChatMessage | undefined } = { last: options.last };
  // Writes run one after another: each chains to the one before.
  let written: Promise<unknown> = Promise.resolve();

  /**
   * Writes the next message, stores it (`keep`) and queues it. Resolves with the message, to add
   * to the local log; it is sent with the next batch. Rejects, taking no seq, with an
   * `InvalidMessageError` for content that doesn't make a well-formed message, or with what
   * `keep` rejected with.
   */
  function write(content: Content, mediaUs: number) {
    const next = chain(written, content, mediaUs);
    written = next;
    return next;
  }

  async function chain(before: Promise<unknown>, content: Content, mediaUs: number) {
    try {
      await before;
    } catch {
      // A refused message before this one took no seq; this one chains past it.
    }

    const prev = await previousHash(state.last);
    const id = await author;
    const seq = (state.last?.seq ?? 0) + 1;
    // copy: once per message written, its content into the message.
    const message: ChatMessage = { author: id, seq, prev, mediaUs, ...content, hlc: NO_CLOCK };
    // Checked before the clock moves on, so a refused message takes no clock value.
    checkMessage(message);
    message.hlc = options.clock.send();
    // Stored before it can be sent: a message sent but lost from the store would let a reload
    // give its seq to another.
    await options.keep(message);
    state.last = message;
    queue.push(message);
    void flushQuietly();
    return message;
  }

  // A flush that a write starts: a batch that fails to seal or publish is already back in the
  // queue, and the next `writable()` reports the failure.
  async function flushQuietly() {
    try {
      await batches.flush();
    } catch {
      // Kept for the next writable event.
    }
  }

  return { write, writable: batches.writable, closed: batches.closed };
}

// The queue sent as batches: whenever the stream is free, everything queued is sealed as one
// batch and handed to it.
function createBatches(options: ChatSenderOptions, queue: ChatMessage[]) {
  const state: {
    writable: boolean;
    /** Counts the stream's closes, so a seal can tell whether one happened meanwhile. */
    closes: number;
    sealing?: Promise<void> | undefined;
  } = { writable: false, closes: 0 };

  // Sends what has queued if the stream is writable; one batch is sealed at a time, and a call
  // made meanwhile waits for it, then looks again.
  async function flush(): Promise<void> {
    if (state.sealing !== undefined) {
      try {
        await state.sealing;
      } catch {
        // The call that started that seal reports its failure.
      }

      return flush();
    }

    if (!state.writable || queue.length === 0) return;

    const sealing = seal(queue.splice(0));
    state.sealing = sealing;

    try {
      await sealing;
    } finally {
      state.sealing = undefined;
    }

    // A seal that put its batch back may have missed a writable event: look again.
    return flush();
  }

  // Puts `messages` back at the front of the queue, in order, for the next writable event.
  function putBack(messages: ChatMessage[]) {
    // copy: `unshift` takes the messages as arguments, a batch's few: those written while the
    // stream was busy.
    queue.unshift(...messages);
  }

  async function encoded(messages: ChatMessage[]) {
    try {
      return await encodeBatch(options.peer, options.content, messages);
    } catch (error) {
      // Nothing is lost: the messages wait for the next writable event.
      putBack(messages);
      throw error;
    }
  }

  async function seal(messages: ChatMessage[]) {
    const closes = state.closes;
    const sealed = await encoded(messages);

    // The stream closed while the batch was sealed, even if it has reopened: the batch goes
    // again, with whatever queued since, once the stream is writable.
    if (state.closes !== closes || !state.writable) {
      putBack(messages);
      return;
    }

    state.writable = false;

    try {
      options.publish(sealed.key, sealed.bytes);
    } catch (error) {
      // The stream refused it: the messages wait for the next writable event.
      putBack(messages);
      throw error;
    }
  }

  /**
   * The stream takes more: the event that sends what has queued. Resolves once the batch is
   * handed over; rejects, keeping the messages queued, if it couldn't be sealed.
   */
  function writable() {
    state.writable = true;
    return flush();
  }

  /** The stream closed: messages queue until it is writable again. */
  function closed() {
    state.writable = false;
    state.closes++;
  }

  return { flush, writable, closed };
}

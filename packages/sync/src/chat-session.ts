// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A peer's chat in one session (docs/architecture.md#chat): the local store, the log, sending,
// receiving and repair, wired together and to the peer's links. Opening it restores what the
// store holds, and queues this peer's messages that may never have been published. The chat
// track itself belongs to the transport: it hands this peer's batches to `publish` and reports
// when the stream takes more, and passes other authors' batches to `received`.

import { createChatHoldings } from "./chat-holdings";
import { createChatLog } from "./chat-log";
import { createChatReceiver } from "./chat-receiver";
import { createChatRepairs } from "./chat-repairs";
import { checkChatControl, createChatResponder } from "./chat-requests";
import { createChatSender, type ChatSenderOptions } from "./chat-sender";
import { openChatStore, unsent } from "./chat-store";
import { keyId, type Bytes, type KeyId } from "./crypto";
import { createClock } from "./hlc";
import type { Link } from "./link";
import { rank } from "./rank";

type Content = Parameters<ReturnType<typeof createChatSender>["write"]>[0];
type Store = Awaited<ReturnType<typeof openChatStore>>;
type Responder = ReturnType<typeof createChatResponder>;
type Pending = Set<Promise<unknown>>;

type State = {
  /** Set by `close`: nothing more is taken or written. */
  closed: boolean;
  /**
   * After a reconnect, who the version vector goes to, best first: the next is sent it if the
   * first one's link closes, until a batch from it arrives.
   */
  catchUp: KeyId[];
};

// A clock value below every message's: this peer's own messages are never late.
const NOT_LATE = "0000000000000000";

export type ChatOptions = {
  /** This peer's key pair. */
  peer: CryptoKeyPair;
  /** The key batches are sealed with: in a watch session, the content key. */
  content: CryptoKey;
  /** The session's directory in OPFS, which holds the chat store. */
  session: FileSystemDirectoryHandle;
  /** Hands a batch to this peer's chat track, as the sender's `publish` does. */
  publish: ChatSenderOptions["publish"];
  /** The wall clock, in milliseconds. */
  now?: () => number;
  /** Called whenever the log may have changed: a message written, or a batch taken. */
  onChange?: () => void;
};

/** The chat was closed: it takes no more messages. */
export class ChatClosedError extends Error {
  override name = "ChatClosedError";
}

// Waits for `work`, counted in each of `pending` until it settles.
async function counted<T>(work: Promise<T>, ...pending: Pending[]) {
  for (const set of pending) set.add(work);

  try {
    return await work;
  } finally {
    for (const set of pending) set.delete(work);
  }
}

/**
 * Opens a peer's chat in a session. Rejects, as `openChatStore` does, for a store that is
 * corrupt or open elsewhere; a store that fails to restore is released again.
 */
export async function openChat(options: ChatOptions) {
  const self = await keyId(options.peer.publicKey);
  const store = await openChatStore(options.session);

  try {
    return await wire(options, self, store);
  } catch (error) {
    await store.close();
    throw error;
  }
}

async function wire(options: ChatOptions, self: KeyId, store: Store) {
  const { content } = options;
  const clock = createClock(options.now);
  const log = createChatLog();
  const holdings = createChatHoldings();
  // Every open link, oldest first, per peer: the relay's and a direct one may both be open.
  const links = new Map<KeyId, Link[]>();
  // What may still write to the store, for `close` to wait for.
  const writing: Pending = new Set();
  const state: State = { closed: false, catchUp: [] };

  // A peer whose links have all gone, though an ask was ranked to it: the ask moves on, as on
  // close.
  function linked(peer: KeyId) {
    if (state.closed) return undefined;

    const link = links.get(peer)?.at(-1);
    if (link === undefined) repairs.closed(peer);
    return link;
  }

  const repairs = createChatRepairs((peer, author, firstSeq) =>
    linked(peer)?.send({ type: "chat-request", author, firstSeq }),
  );
  const receiver = createChatReceiver({
    content,
    clock,
    log,
    holdings,
    repairs,
    store,
    // copy: `rank` takes an array.
    candidates: () => [...links.keys()],
  });

  await receiver.restore(store.records);

  // Takes a batch; one that doesn't prove itself changes nothing, and a repair it answered has
  // already moved on.
  async function take(key: string, bytes: Bytes, from?: KeyId) {
    if (state.closed) return;

    try {
      await receiver.receive(key, bytes, from);
    } catch {
      // Refused: nothing to do.
      return;
    }

    options.onChange?.();
  }

  const { write, writable, unwritable } = createOwnChat({
    chat: options,
    self,
    store,
    log,
    clock,
    state,
    writing,
    take,
  });

  /** A batch from an author's chat track. */
  const received = (key: string, bytes: Bytes) => counted(take(key, bytes), writing);

  const { connect, reconnected } = createPeerLinks({
    self,
    content,
    log,
    holdings,
    repairs,
    links,
    state,
    take: (key, bytes, peer) => counted(take(key, bytes, peer), writing),
  });

  /**
   * Stops taking messages and batches, waits for what is still being written, and releases the
   * chat store, for the session to be opened again or deleted.
   */
  async function close() {
    state.closed = true;
    await Promise.all(writing);
    await store.close();
  }

  return {
    id: self,
    entries: log.entries,
    write,
    received,
    writable,
    unwritable,
    connect,
    reconnected,
    close,
  };
}

type OwnChatOptions = {
  chat: ChatOptions;
  self: KeyId;
  store: Store;
  log: ReturnType<typeof createChatLog>;
  clock: ReturnType<typeof createClock>;
  state: State;
  /** What may still write to the store, shared with the session. */
  writing: Pending;
  /** Takes a batch into the log and holdings, as one from another author is. */
  take(key: string, bytes: Bytes): Promise<void>;
};

// This peer's own chat: each message stored and shown, then sent, and each batch taken back
// into the holdings. Messages the store holds that may never have been published go first.
function createOwnChat(options: OwnChatOptions) {
  const { chat, self, store, log, state, writing } = options;
  // This peer's own batches on their way into the holdings, for `writable` to wait for.
  const own: Pending = new Set();
  const records = store.records.get(self) ?? { messages: [], checkpoints: [] };
  const { last, pending } = unsent(records);

  // Stored, then shown, before the sender can queue it: the batch that carries it back finds it
  // in the log already, so it is never marked late.
  async function keep(message: Parameters<ChatSenderOptions["keep"]>[0]) {
    if (state.closed) throw new ChatClosedError("the chat is closed");

    await counted(store.append(self, { messages: [message] }), writing);
    log.add(message, NOT_LATE);
    chat.onChange?.();
  }

  // This peer's own batch goes through the same path as everyone's, into the holdings, so it
  // can answer repairs of it. A throw from the track reaches the sender, which keeps the batch.
  function publish(key: string, bytes: Bytes) {
    if (state.closed) throw new ChatClosedError("the chat is closed");

    chat.publish(key, bytes);
    void counted(options.take(key, bytes), writing, own);
  }

  const sender = createChatSender({
    peer: chat.peer,
    content: chat.content,
    clock: options.clock,
    keep,
    last,
    pending,
    publish,
  });

  /**
   * Writes a message: stored, shown in the log, and sent with the next batch. Resolves with the
   * message; rejects as `createChatSender`'s `write` does, or with a `ChatClosedError`.
   */
  const write = (message: Content, mediaUs: number) => sender.write(message, mediaUs);

  /**
   * The chat track takes more: sends what has queued. Resolves once the batch is handed over
   * and in this peer's holdings.
   */
  async function writable() {
    await sender.writable();
    await Promise.all(own);
  }

  /** The chat track closed: messages queue until it is writable again. */
  const unwritable = () => sender.closed();

  return { write, writable, unwritable };
}

type PeerLinksOptions = {
  self: KeyId;
  content: CryptoKey;
  log: ReturnType<typeof createChatLog>;
  holdings: ReturnType<typeof createChatHoldings>;
  repairs: ReturnType<typeof createChatRepairs>;
  /** Every open link, oldest first, per peer, shared with the session. */
  links: Map<KeyId, Link[]>;
  state: State;
  /** Takes a batch a peer delivered, counted among what may still write to the store. */
  take(key: string, bytes: Bytes, peer: KeyId): Promise<unknown>;
};

// The session's links to peers: each one's requests answered, the batches it delivers taken,
// and the version vector sent after a reconnect, moving on as links close.
function createPeerLinks(options: PeerLinksOptions) {
  const { self, log, repairs, links, state } = options;
  const newest = (peer: KeyId) => links.get(peer)?.at(-1);

  // Sends the version vector to the best peer still linked, if a catch-up is under way.
  function catchUp() {
    const next = state.catchUp.findIndex((peer) => newest(peer) !== undefined);
    // Peers ranked above it have no link left.
    if (next === -1) state.catchUp = [];
    else state.catchUp.splice(0, next);
    const [peer] = state.catchUp;
    if (peer === undefined) return;
    newest(peer)?.send({ type: "chat-versions", versions: log.versions() });
  }

  // A control message from a peer: a chat-gone for an ask of this peer's, or a request to answer.
  function handle(peer: KeyId, responder: Responder, value: unknown) {
    const message = checkChatControl(value);
    if (state.closed || message === undefined) return undefined;

    if (message.type === "chat-gone") {
      repairs.gone(peer, message.author, message.firstSeq);
      return undefined;
    }

    return responder.requested(peer, message);
  }

  // An object a peer delivered: a batch answering a repair or a version vector.
  function delivered(peer: KeyId, key: string, bytes: Bytes) {
    if (!key.startsWith("chat/")) return undefined;
    if (state.catchUp[0] === peer) state.catchUp = [];
    return options.take(key, bytes, peer);
  }

  // A link closed. Asks don't record which of a peer's links they went on, so every ask waiting
  // on that peer moves on: at worst the next peer is asked too, and the first answer fills the
  // gap. The version vector moves on only once the peer has no link left.
  function unlinked(link: Link) {
    const { peer } = link;
    const rest = (links.get(peer) ?? []).filter((l) => l !== link);
    if (rest.length > 0) links.set(peer, rest);
    else links.delete(peer);
    if (state.closed) return;

    repairs.closed(peer);

    if (rest.length === 0 && state.catchUp[0] === peer) {
      state.catchUp.shift();
      catchUp();
    }
  }

  /**
   * A link to a peer has opened: the peer is a candidate for repairs while any of its links is.
   * Asks go on its newest link, and a request is answered on the link it came on.
   */
  function connect(link: Link) {
    const { peer } = link;
    const held = links.get(peer);
    if (held) held.push(link);
    else links.set(peer, [link]);
    const responder = createChatResponder({
      content: options.content,
      holdings: options.holdings,
      send: (_, message) => link.send(message),
      deliver: (_, key, bytes) => link.deliver(key, bytes),
    });
    link.on("message", (value) => handle(peer, responder, value));
    link.on("object", (key, bytes) => delivered(peer, key, bytes));
    link.on("close", () => unlinked(link));
  }

  /**
   * This peer is back online: sends its version vector to the linked peer ranked first by
   * `SHA-256(peer ‖ self ‖ "chat-versions")`, which replies with everything beyond it. If that
   * peer's last link closes before a batch from it arrives, the next one is sent the vector.
   */
  async function reconnected() {
    // copy: `rank` takes an array.
    const ranked = await rank([...links.keys()], self, "chat-versions");
    state.catchUp = ranked;
    catchUp();
  }

  return { connect, reconnected };
}

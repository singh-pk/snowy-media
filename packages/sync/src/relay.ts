// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The connection to the relay (docs/architecture.md#the-relay): MoQ over WebTransport, through
// the `@moq/net` client. One connection per peer per session gives:
//
// - presence: a peer is online while its broadcast `peer/<PeerId>` is announced;
// - this peer's tracks under `peer/<self>`, and subscriptions to other peers' tracks;
// - the source's tracks under `source`, published by the source and subscribed by the rest;
// - a `Link` to each online peer, over the inbox broadcasts.
//
// Every object is a group of its own, so one lost or slow object never holds up another, and
// objects may arrive in any order. Everything is driven by the transport's events.

import * as Moq from "@moq/net";
import { isRecord } from "./chat";
import type { Bytes, KeyId } from "./crypto";
import type { Link, LinkEvents, Message } from "./link";

export type RelayOptions = {
  /** The relay's WebTransport URL. */
  url: string;
  /**
   * For a relay whose certificate no authority signs, such as one in tests: the certificate's
   * SHA-256 hashes, as WebTransport takes them.
   */
  serverCertificateHashes?: Array<{ algorithm: "sha-256"; value: BufferSource }>;
  session: KeyId;
  /** This peer's id. */
  self: KeyId;
  /**
   * What the relay admits this peer with: a token from `peerToken` or `sourceToken`
   * (src/relay-auth.ts), made just before connecting.
   */
  token: string;
  /**
   * The names of the tracks this peer publishes under `peer/<self>`. They exist before the peer
   * is announced, so a peer that subscribes on seeing it online finds every one.
   */
  tracks: string[];
  /**
   * The source only: the names of the tracks it publishes under `source`, such as `catalog` and
   * `init/<track>`. Like this peer's own, they exist before the broadcast is announced.
   */
  source?: string[];
};

export type RelayEvents = {
  /** A peer's broadcast was announced: it is online. */
  announce(peer: KeyId): unknown;
  /** A peer's broadcast was withdrawn: it is offline, and its link has closed. */
  unannounce(peer: KeyId): unknown;
  /** A link to a peer has opened: each end can now reach the other. */
  link(link: Link): unknown;
  /**
   * The connection closed, and with it every link. Links' `close` and peers' `unannounce` may
   * come before or after it. `refused` is true if the relay refused the token: it admits a
   * connection only after it is made, so a refusal ends one instead, and connecting again with
   * the same grant fails again.
   */
  close(refused: boolean): unknown;
};

/** A track this peer publishes: each object sent is a group of its own. */
type Publisher = { send(payload: Bytes): void; stop(): void };

/** A subscription to a track, which `cancel` ends. */
type Subscription = { cancel: () => void };

/** The relay refused a request. */
export class RelayRequestError extends Error {
  override name = "RelayRequestError";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Ranks by a track name's first segment, highest first (docs/architecture.md#mapping-to-moq):
// control, then inbox, then chat, then the records, then init, then media, then probe. The order
// among media tracks, by kind, comes with the source, which knows each track's kind.
const RANK: Record<string, number> = {
  control: 0,
  ctl: 1,
  deliver: 1,
  chat: 2,
  catalog: 3,
  caps: 3,
  have: 3,
  init: 4,
  media: 5,
};
const LOWEST = 6;

// MoQ serves a higher priority first.
const priority = (name: string) => LOWEST - (RANK[name.split("/")[0] ?? name] ?? LOWEST);

// Every frame carries the same timestamp. `@moq/net` skips a group once a newer one is further
// ahead in time than the subscriber's age budget, which suits media; here nothing may be
// skipped, and with no time between groups, none ever is.
const STAMP = Moq.Time.Timestamp.fromMillis(0);
const AGE = Moq.Time.Milli(1);

// The message that opens a link, which never reaches the link's handlers.
const OPEN = "link-open";
const OPEN_BYTES = encoder.encode(JSON.stringify({ type: OPEN }));

/** An object with its key, framed as a 2-byte key length, the key, then the bytes. */
export function frame(key: string, bytes: Bytes): Bytes {
  const name = encoder.encode(key);
  if (name.length > 0xffff) throw new RangeError("an object's key is longer than 65535 bytes");
  const framed = new Uint8Array(2 + name.length + bytes.length);
  new DataView(framed.buffer).setUint16(0, name.length);
  framed.set(name, 2);
  framed.set(bytes, 2 + name.length);
  return framed;
}

/** An object framed by `frame`, or undefined for bytes that aren't one. */
export function unframe(framed: Bytes) {
  if (framed.length < 2) return undefined;

  const length = new DataView(framed.buffer, framed.byteOffset).getUint16(0);
  if (framed.length < 2 + length) return undefined;
  const key = decoder.decode(framed.subarray(2, 2 + length));
  return { key, bytes: framed.subarray(2 + length) };
}

// A message on `ctl`, or undefined for one that isn't JSON.
function parsed(payload: Bytes): unknown {
  try {
    return JSON.parse(decoder.decode(payload));
  } catch {
    return undefined;
  }
}

// Waits for what a handler returned, reporting it if it rejects.
async function settle(returned: unknown) {
  try {
    await returned;
  } catch (error) {
    reportError(error);
  }
}

// Calls a handler, reporting what it throws or rejects with rather than passing it to the
// transport event that called it, which would stop that event's loop.
function call<Args extends unknown[]>(handler: (...args: Args) => unknown, ...args: Args) {
  try {
    void settle(handler(...args));
  } catch (error) {
    reportError(error);
  }
}

// The handlers registered for each event.
function emitter<Events extends Record<string, (...args: never[]) => unknown>>(handlers: {
  [E in keyof Events]: Array<Events[E]>;
}) {
  function on<E extends keyof Events>(event: E, handler: Events[E]) {
    handlers[event].push(handler);
  }

  function emit<E extends keyof Events>(event: E, ...args: Parameters<Events[E]>) {
    for (const handler of handlers[event]) call(handler, ...args);
  }

  return { on, emit };
}

// Resolves with `value` once `waiting` settles, whether it resolves or rejects.
async function after<T>(waiting: PromiseLike<unknown>, value: T) {
  try {
    await waiting;
  } catch {
    // Settled all the same.
  }

  return value;
}

// The broadcast a request resolves to, or undefined if it is refused first or nothing can serve
// it, as once the connection has closed.
async function resolved(request: Moq.Origin.Requesting) {
  for (;;) {
    const active = request.active.peek();
    if (active !== undefined) return active;
    if (request.unroutable.peek()) return undefined;
    const changed = await Promise.race([
      after(request.active.changed(), true),
      after(request.unroutable.changed(), true),
      after(request.closed, false),
    ]);
    if (!changed) return undefined;
  }
}

// Whether `waiting` resolves rather than rejects.
async function resolves(waiting: PromiseLike<unknown>) {
  try {
    await waiting;
    return true;
  } catch {
    return false;
  }
}

// Whether the publisher accepted a subscription, which then carries the track's info, rather
// than refusing or closing it.
const accepted = (track: Moq.Track.Subscriber) =>
  Promise.race([resolves(track.info()), after(track.closed, false)]);

// The next group on a subscription, or undefined once it ends, fails or is cancelled.
async function nextGroup(track: Moq.Track.Subscriber) {
  try {
    return await track.recvGroup();
  } catch {
    return undefined;
  }
}

// Hands a group's one frame to `handle`. A group the publisher reset hands on nothing.
async function readGroup(group: Moq.Group.Consumer, handle: (payload: Bytes) => unknown) {
  try {
    const frameRead = await group.readFrame();
    // Frames are shared with other readers, so each is copied once here, and what reads it, such
    // as `unframe`, copies nothing.
    if (frameRead !== undefined) call(handle, new Uint8Array(frameRead.payload));
  } catch {
    // Reset by the publisher, or ended with the subscription.
  }
}

// Hands each object on a subscription to `handle`, as each group arrives, then calls `ended`
// once the subscription ends, however it ends.
async function read(
  track: Moq.Track.Subscriber,
  handle: (payload: Bytes) => unknown,
  ended: () => void,
) {
  for (;;) {
    const group = await nextGroup(track);

    if (group === undefined) {
      call(ended);
      return;
    }

    void readGroup(group, handle);
  }
}

// Publishes a track of `broadcast`: the relay forwards it to whoever subscribes.
function publisher(broadcast: Moq.Broadcast.Producer, name: string): Publisher {
  const track = broadcast.createTrack(name, { priority: priority(name) });
  const sent = { stopped: false };

  function send(payload: Bytes) {
    if (sent.stopped) throw new RelayRequestError(`${track.name} has stopped`);
    const group = track.appendGroup();
    group.writeFrame({ payload, timestamp: STAMP });
    group.close();
  }

  function stop() {
    sent.stopped = true;
    track.close();
  }

  return { send, stop };
}

// The URL of the session's root on the relay, `snowy/<SessionId>`, under the relay's own path,
// with the token the relay hands its auth server.
function sessionUrl(relay: string, session: KeyId, token: string) {
  const url = new URL(relay);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/snowy/${session}`;
  url.searchParams.set("token", token);
  return url;
}

// Subscribes to a track, handing each object's payload to `handle`, once the relay accepts the
// subscription; `stopped` is called if it ends without being cancelled.
type Subscribe = (
  path: Moq.Path.Valid,
  name: string,
  handle: (payload: Bytes) => unknown,
  stopped?: () => void,
) => Promise<Subscription>;

// Subscribing to tracks the relay announces, refused once the connection has closed.
function createSubscribe(remote: Moq.Origin.Producer, state: { closed: boolean }): Subscribe {
  return async (path, name, handle, stopped = () => undefined) => {
    if (state.closed)
      throw new RelayRequestError(`subscribe ${path}/${name}: the connection closed`);
    const request = remote.request(path);
    const broadcast = await resolved(request);

    if (broadcast === undefined) {
      request.close();
      throw new RelayRequestError(`subscribe ${path}/${name}`);
    }

    const subscription = broadcast.track(name).subscribe({ priority: priority(name), maxAge: AGE });
    const cancelled = { now: false };

    function cancel() {
      cancelled.now = true;
      subscription.close();
      request.close();
    }

    const ok = await accepted(subscription);

    if (!ok) {
      cancel();
      throw new RelayRequestError(`subscribe ${path}/${name}`);
    }

    void read(subscription, handle, () => {
      if (cancelled.now) return;
      request.close();
      stopped();
    });
    return { cancel };
  };
}

/** What a connection shares with its links and its presence. */
type RelayContext = {
  self: KeyId;
  /** What this peer publishes, and what the relay announces to it, relative to the session. */
  local: Moq.Origin.Producer;
  remote: Moq.Origin.Producer;
  events: ReturnType<typeof emitter<RelayEvents>>;
  /** The current link to each peer: a link leaves it as it shuts. */
  links: Map<KeyId, RelayLink>;
  state: { closed: boolean };
  subscribe: Subscribe;
};

type RelayLink = {
  link: Link;
  /**
   * Whether this link's inbox from the peer has been announced, which a withdrawal of an
   * earlier one, coming late, mustn't close.
   */
  seen: { inbox: boolean };
  /** The other end has announced its side: subscribe, then say this end is listening. */
  inbound: () => Promise<void>;
  /** Ends this link's subscriptions and withdraws its broadcast. */
  shut: () => void;
};

type LinkStatus = {
  listening: boolean;
  subscribed: boolean;
  heard: boolean;
  open: boolean;
  closed: boolean;
};

/** The parts of a link that subscribing to the other end's side uses. */
type LinkEnds = {
  status: LinkStatus;
  subscriptions: Subscription[];
  heard: (payload: Bytes) => void;
  object: (payload: Bytes) => void;
  post: (payload: Bytes) => void;
  open: (answer: boolean) => void;
  shut: () => void;
};

// This end's side of a link, `inbox/<peer>/<self>`. Its tracks exist before the broadcast is
// announced, so the other end finds both when it subscribes on seeing it. An earlier link to the
// peer has withdrawn its broadcast at this path already: a link leaves `links`, which is the only
// way to a new one, as it shuts.
function outbox(local: Moq.Origin.Producer, peer: KeyId, self: KeyId) {
  const broadcast = local.createBroadcast(Moq.Path.from("inbox", peer, self));
  const ctl = publisher(broadcast, "ctl");
  const deliver = publisher(broadcast, "deliver");
  broadcast.announce();

  function close() {
    ctl.stop();
    deliver.stop();
    broadcast.close();
  }

  return { ctl, deliver, close };
}

// Keeps a subscription, or ends it if the link closed while the relay was answering.
async function keep(ends: LinkEnds, subscribing: Promise<Subscription>) {
  const subscription = await subscribing;
  ends.subscriptions.push(subscription);
  if (ends.status.closed) subscription.cancel();
}

// Subscribes to the other end's side of a link, at `path`, then says this end is listening.
async function listenTo(subscribe: Subscribe, path: Moq.Path.Valid, ends: LinkEnds) {
  const { status } = ends;
  if (status.listening || status.closed) return;
  status.listening = true;

  // A subscription the relay ends leaves this end deaf to the other: close the link, so the
  // peer's next announcement opens a new one.
  try {
    await Promise.all([
      keep(ends, subscribe(path, "ctl", ends.heard, ends.shut)),
      keep(ends, subscribe(path, "deliver", ends.object, ends.shut)),
    ]);
  } catch {
    // The relay refused: the link never opens, and closes with the peer.
    return;
  }

  if (status.closed) return;
  status.subscribed = true;
  ends.post(OPEN_BYTES);
  if (status.heard && !status.open) ends.open(false);
}

// A link to `peer` over the inbox broadcasts: this peer publishes `inbox/<peer>/<self>` and
// subscribes to `inbox/<self>/<peer>`, each with a `ctl` track for messages and a `deliver`
// track for objects. It opens once this end has both subscriptions and has heard from the
// other end, which sends nothing before it has both of its own.
function relayLink(context: RelayContext, peer: KeyId): RelayLink {
  const { self, links } = context;
  const handlers = emitter<LinkEvents>({ message: [], object: [], close: [] });
  const status: LinkStatus = {
    listening: false,
    subscribed: false,
    heard: false,
    open: false,
    closed: false,
  };
  const seen = { inbox: false };
  const subscriptions: Subscription[] = [];
  // What arrived before the link opened, handed to its handlers in order once it does.
  const early: Array<() => void> = [];
  const out = outbox(context.local, peer, self);

  const link: Link = {
    peer,
    send: (message: Message) => post(encoder.encode(JSON.stringify(message))),
    deliver: (key, bytes) => {
      if (status.open && !status.closed) out.deliver.send(frame(key, bytes));
    },
    on: handlers.on,
    close: () => shut(),
  };

  function post(payload: Bytes) {
    if (!status.closed) out.ctl.send(payload);
  }

  // Opens the link, then hands on what arrived early. Answers with an open of its own when
  // this end's first one may have gone before the other end subscribed.
  function open(answer: boolean) {
    status.open = true;
    if (answer) post(OPEN_BYTES);
    context.events.emit("link", link);
    for (const arrival of early.splice(0)) arrival();
  }

  // Something arrived from the other end, which proves it subscribed to this one: the link
  // opens if this end has subscribed too. `handOn` is what goes to the handlers, if anything.
  function arrived(handOn?: () => void) {
    if (status.closed) return;

    if (status.open) {
      handOn?.();
      return;
    }

    if (handOn !== undefined) early.push(handOn);
    status.heard = true;
    if (status.subscribed) open(true);
  }

  function heard(payload: Bytes) {
    const value = parsed(payload);
    if (value === undefined) return;
    const opening = isRecord(value) && value.type === OPEN;
    arrived(opening ? undefined : () => handlers.emit("message", value));
  }

  function object(payload: Bytes) {
    const framed = unframe(payload);
    if (framed !== undefined) arrived(() => handlers.emit("object", framed.key, framed.bytes));
  }

  function shut() {
    if (status.closed) return;
    status.closed = true;
    if (links.get(peer)?.link === link) links.delete(peer);
    early.length = 0;
    const wasOpen = status.open;
    status.open = false;
    if (wasOpen) handlers.emit("close");
    for (const subscription of subscriptions) subscription.cancel();
    out.close();
  }

  const ends: LinkEnds = { status, subscriptions, heard, object, post, open, shut };
  const path = Moq.Path.from("inbox", self, peer);
  return { link, seen, inbound: () => listenTo(context.subscribe, path, ends), shut };
}

// Presence and links: who is online, from the peers' broadcasts, and a link to each, subscribed
// once its inbox for this peer is announced too.
function createPresence(context: RelayContext) {
  const { self, links, events } = context;
  const online = new Set<KeyId>();
  // Peers whose inbox for this peer, `inbox/<self>/<peer>`, is announced.
  const inboxes = new Set<KeyId>();

  function linkTo(peer: KeyId) {
    const existing = links.get(peer);
    if (existing !== undefined) return existing;

    const created = relayLink(context, peer);
    links.set(peer, created);
    return created;
  }

  // Subscribes to a peer's side of its link, once both its broadcast and its inbox for this
  // peer are announced, which may come in either order.
  function hearFrom(peer: KeyId) {
    if (online.has(peer) && inboxes.has(peer)) void linkTo(peer).inbound();
  }

  // An announcement or withdrawal of `peer/<PeerId>`.
  function present(update: Moq.Announce.Update) {
    const peer = Moq.Path.parts(update.prefix)[1];
    if (peer === undefined || peer === self) return;

    if (Moq.Announce.isActive(update.kind)) {
      if (online.has(peer)) return;
      online.add(peer);
      linkTo(peer);
      events.emit("announce", peer);
      hearFrom(peer);
      return;
    }

    if (online.delete(peer)) {
      links.get(peer)?.shut();
      events.emit("unannounce", peer);
    }
  }

  // An announcement or withdrawal of `inbox/<self>/<PeerId>`.
  function inbox(update: Moq.Announce.Update) {
    const peer = Moq.Path.parts(update.prefix)[2];
    if (peer === undefined) return;

    if (Moq.Announce.isActive(update.kind)) {
      if (inboxes.has(peer)) return;
      inboxes.add(peer);
      linkTo(peer).seen.inbox = true;
      hearFrom(peer);
      return;
    }

    if (inboxes.delete(peer)) {
      const link = links.get(peer);
      if (link?.seen.inbox === true) link.shut();
    }
  }

  // Hands each announcement and withdrawal under `scope` to `handle`, until the connection ends.
  async function follow(scope: string, handle: (update: Moq.Announce.Update) => void) {
    const updates = context.remote.announced(Moq.Path.Pattern.parse(scope));

    for await (const update of updates) {
      if (context.state.closed) return;
      call(handle, update);
    }
  }

  /**
   * Starts presence and links: follows this peer's inboxes and the peers' broadcasts, so
   * `announce` fires for every peer online, and `link` as each link opens. Called once the
   * handlers are registered, so none misses an event.
   */
  function listen() {
    void follow(`inbox/${self}/*`, inbox);
    void follow("peer/*", present);
  }

  return { listen };
}

// This peer's tracks under `peer/<self>` and, for the source, its tracks under `source`, each
// announced with its tracks in place. The source announces `source` before itself, so a peer
// that subscribes to it on seeing the source online finds it.
function publishTracks(local: Moq.Origin.Producer, options: RelayOptions) {
  const sourceTracks = new Map<string, Publisher>();

  if (options.source !== undefined) {
    const broadcast = local.createBroadcast(Moq.Path.from("source"));
    for (const name of options.source) sourceTracks.set(name, publisher(broadcast, name));
    broadcast.announce();
  }

  const own = local.createBroadcast(Moq.Path.from("peer", options.self));
  const ownTracks = new Map(options.tracks.map((name) => [name, publisher(own, name)]));
  own.announce();
  return { ownTracks, sourceTracks };
}

/**
 * Connects to the relay with this peer's tracks announced; `listen` then starts presence and
 * links. Rejects if the connection fails; a token the relay refuses ends the connection with
 * `close` instead.
 */
export async function connectRelay(options: RelayOptions) {
  const local = new Moq.Origin.Producer();
  const remote = new Moq.Origin.Producer();
  const state = { closed: false };
  const context: RelayContext = {
    self: options.self,
    local,
    remote,
    events: emitter<RelayEvents>({ announce: [], unannounce: [], link: [], close: [] }),
    links: new Map(),
    state,
    subscribe: createSubscribe(remote, state),
  };
  const { links, events, subscribe: subscriber } = context;
  const { ownTracks, sourceTracks } = publishTracks(local, options);
  const presence = createPresence(context);

  // Ends everything this peer published or watched.
  function release() {
    for (const { shut } of links.values()) shut();
    for (const published of ownTracks.values()) published.stop();
    for (const published of sourceTracks.values()) published.stop();
    local.close();
    remote.close();
  }

  async function connect() {
    try {
      return await Moq.Connection.connect({
        url: sessionUrl(options.url, options.session, options.token),
        webtransport: { serverCertificateHashes: options.serverCertificateHashes ?? [] },
        websocket: { enabled: false },
        publish: local.consume(),
        consume: remote,
      });
    } catch (error) {
      release();
      throw error;
    }
  }

  const established = await connect();

  async function ended() {
    const cause = await established.closed;
    if (state.closed) return;
    state.closed = true;
    release();
    const refused =
      cause instanceof Moq.Error.Session && cause.code === Moq.SessionCode.Unauthorized;
    events.emit("close", refused);
  }

  void ended();

  /**
   * One of this peer's tracks, `peer/<self>/<name>`; each object goes as a group. Its `send`
   * throws a `RelayRequestError` once the connection has closed.
   */
  function track(name: string) {
    const published = ownTracks.get(name);
    if (published === undefined) throw new Error(`${name} isn't one of this peer's tracks`);
    return published;
  }

  /**
   * One of the source's tracks, `source/<name>`, for the peer connected with `source`; each
   * object goes as a group. Its `send` throws a `RelayRequestError` once the connection has closed.
   */
  function sourceTrack(name: string) {
    const published = sourceTracks.get(name);
    if (published === undefined) throw new Error(`${name} isn't one of the source's tracks`);
    return published;
  }

  /**
   * Subscribes to a peer's track, `peer/<peer>/<name>`. The first objects may be ones sent in the
   * last few seconds, which the peer still keeps. Resolves with a function that ends the
   * subscription; it also ends by itself when the peer stops serving the track or the connection
   * closes. Rejects with a `RelayRequestError` if the relay refuses, or the connection has closed.
   */
  async function subscribe(peer: KeyId, name: string, handle: (payload: Bytes) => unknown) {
    const { cancel } = await subscriber(Moq.Path.from("peer", peer), name, handle);
    return cancel;
  }

  /**
   * Subscribes to one of the source's tracks, `source/<name>`, as `subscribe` does to a peer's.
   * Rejects with a `RelayRequestError` if the source isn't connected. The subscription ends by
   * itself when the source leaves; its peer's `unannounce` says so, and subscribing again once it
   * is back reaches it.
   */
  async function subscribeSource(name: string, handle: (payload: Bytes) => unknown) {
    const { cancel } = await subscriber(Moq.Path.from("source"), name, handle);
    return cancel;
  }

  /** Withdraws this peer and closes the connection. */
  async function close() {
    established.close();
    await established.closed;
  }

  return {
    on: events.on,
    listen: presence.listen,
    track,
    sourceTrack,
    subscribe,
    subscribeSource,
    close,
  };
}

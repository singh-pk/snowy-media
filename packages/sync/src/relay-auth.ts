// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Relay authorization (docs/architecture.md#authorization), and the server moq-relay asks through
// `--auth-url`. It keeps nothing: each answer comes from the token, the dialed path and the app's
// `admit` alone.

import { isRecord } from "./chat";
import { RIGHTS, readGrant, verifyGrant, type Grant, type Right } from "./grant";
import { base64url, isKeyId, keyId, sign, signedBy, type KeyId } from "./crypto";

/** How long after it is made a token admits a new connection, in milliseconds: 5 minutes. */
export const TOKEN_AGE = 5 * 60_000;
/** How far ahead of the auth server's clock a token may be made, in milliseconds: 1 minute. */
export const TOKEN_SKEW = 60_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The session key's permission for anyone with the invite to join, carried in the invite link. */
export type JoinGrant = { session: KeyId; rights: "viewer"; sig: string };

/** What a peer signs to connect: who it is, the session, and when, in milliseconds. */
type ConnectionRequest = { peer: KeyId; session: KeyId; issuedAt: number };

// A watch session's peer and source, and an edit session's peer with a grant and its owner.
type Token =
  | { kind: "peer"; grant: JoinGrant; request: ConnectionRequest; sig: string }
  | { kind: "source"; request: ConnectionRequest; sig: string; sessionSig: string }
  | { kind: "editor"; grant: Grant; request: ConnectionRequest; sig: string }
  | { kind: "owner"; request: ConnectionRequest; sig: string; sessionSig: string };

// The prefix under which the session key (the project key, for an owner) signs the peer's
// request in a source's or owner's token.
const SESSION_PREFIX = { source: "snowy source v1", owner: "snowy owner v1" } as const;

/** What the relay lets a connection do: moq-relay's grant, patterns relative to the dialed path. */
export type RelayGrant = { publish: string[]; subscribe: string[] };

// Each signed thing has its own prefix, so a signature over one can't pass for another.
const grantBytes = (session: KeyId) =>
  encoder.encode(`snowy join v1\n${JSON.stringify({ session, rights: "viewer" })}`);

const requestBytes = (prefix: string, { peer, session, issuedAt }: ConnectionRequest) =>
  encoder.encode(`${prefix}\n${JSON.stringify({ peer, session, issuedAt })}`);

const encode = (token: Token) => base64url(encoder.encode(JSON.stringify(token)));

export async function joinGrant(session: CryptoKeyPair): Promise<JoinGrant> {
  const id = await keyId(session.publicKey);
  const sig = await sign(session.privateKey, grantBytes(id));
  return { session: id, rights: "viewer", sig: base64url(sig) };
}

async function connectionRequest(peer: CryptoKeyPair, session: KeyId) {
  const id = await keyId(peer.publicKey);
  const request = { peer: id, session, issuedAt: Date.now() };
  const sig = await sign(peer.privateKey, requestBytes("snowy relay v1", request));
  return { request, sig: base64url(sig) };
}

/**
 * A peer's token for the relay, from the session's join grant. It admits a connection for
 * `TOKEN_AGE` after it is made, so a peer makes one each time it connects.
 */
export async function peerToken(grant: JoinGrant, peer: CryptoKeyPair) {
  const { request, sig } = await connectionRequest(peer, grant.session);
  return encode({ kind: "peer", grant, request, sig });
}

async function keyHolderToken(
  kind: "source" | "owner",
  session: CryptoKeyPair,
  peer: CryptoKeyPair,
) {
  const id = await keyId(session.publicKey);
  const { request, sig } = await connectionRequest(peer, id);
  const sessionSig = await sign(session.privateKey, requestBytes(SESSION_PREFIX[kind], request));
  return encode({ kind, request, sig, sessionSig: base64url(sessionSig) });
}

/** The source's token for the relay, signed by both the session key and its own peer key. */
export const sourceToken = (session: CryptoKeyPair, peer: CryptoKeyPair) =>
  keyHolderToken("source", session, peer);

/**
 * A peer's token for an edit session's relay, from the grant it holds: one given to its key, an
 * invite, or, for an agent, one its person passed on. Like `peerToken`'s, it admits for
 * `TOKEN_AGE`.
 */
export async function editorToken(grant: Grant, peer: CryptoKeyPair) {
  const { request, sig } = await connectionRequest(peer, grant.session);
  return encode({ kind: "editor", grant, request, sig });
}

/**
 * The project owner's token for an edit session's relay, signed by both the project key and its
 * own peer key.
 */
export const ownerToken = (project: CryptoKeyPair, peer: CryptoKeyPair) =>
  keyHolderToken("owner", project, peer);

// The session a dialed path is the root of: it ends in `snowy/<SessionId>`, under whatever path
// the relay's URL has. Each prefix roots a separate tree, and a grant's patterns are relative to
// it, so a peer that dials another prefix reaches only peers that dialed the same.
function sessionOf(path: string) {
  const parts = path.split("/");
  const session = parts.at(-1);
  return parts.at(-2) === "snowy" && isKeyId(session) ? session : undefined;
}

function checkRequest(value: unknown): ConnectionRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { peer, session, issuedAt } = value;
  const valid = isKeyId(peer) && isKeyId(session) && typeof issuedAt === "number";
  return valid && Number.isSafeInteger(issuedAt) ? { peer, session, issuedAt } : undefined;
}

// The token in a dialed query, `token=…`, checked for shape only, or undefined.
function readToken(query: string | undefined): Token | undefined {
  const param = new URLSearchParams(query ?? "").get("token");
  if (param === null) return undefined;

  let json: unknown;

  try {
    json = JSON.parse(decoder.decode(Uint8Array.fromBase64(param, { alphabet: "base64url" })));
  } catch {
    return undefined;
  }

  if (!isRecord(json) || typeof json.sig !== "string") return undefined;
  const request = checkRequest(json.request);
  if (request === undefined) return undefined;
  const { kind, grant, sig, sessionSig } = json;

  if (kind === "peer" && isRecord(grant)) {
    const { session, rights, sig: grantSig } = grant;
    const valid = isKeyId(session) && rights === "viewer" && typeof grantSig === "string";
    return valid ? { kind, grant: { session, rights, sig: grantSig }, request, sig } : undefined;
  }

  if (kind === "editor") {
    const editGrant = readGrant(grant);
    return editGrant === undefined ? undefined : { kind, grant: editGrant, request, sig };
  }

  if ((kind === "source" || kind === "owner") && typeof sessionSig === "string") {
    return { kind, request, sig, sessionSig };
  }

  return undefined;
}

// Whether a token's grant, or the session key's signature, admits its peer to `session`.
function bySession(token: Token, session: KeyId) {
  const { request } = token;

  if (token.kind === "peer") {
    return (
      token.grant.session === session && signedBy(session, token.grant.sig, grantBytes(session))
    );
  }

  if (token.kind === "editor") {
    const { to } = token.grant;
    return (to === undefined || to === request.peer) && verifyGrant(token.grant, session);
  }

  return signedBy(session, token.sessionSig, requestBytes(SESSION_PREFIX[token.kind], request));
}

// Whether every signature on a token checks out, by the keys of `session` and its peer.
async function verified(token: Token, session: KeyId) {
  const { request } = token;
  const checks = await Promise.all([
    bySession(token, session),
    signedBy(request.peer, token.sig, requestBytes("snowy relay v1", request)),
  ]);
  return checks.every(Boolean);
}

const peerGrant = (peer: KeyId): RelayGrant => ({
  publish: [`peer/${peer}`, `inbox/*/${peer}`],
  subscribe: ["source", "peer/*", `inbox/${peer}/*`],
});

const sourceGrant = (peer: KeyId): RelayGrant => ({
  publish: ["source", `peer/${peer}`, `inbox/*/${peer}`],
  subscribe: ["**"],
});

async function checked(path: string, query: string | undefined, now: number, fresh: boolean) {
  const session = sessionOf(path);
  const token = readToken(query);
  if (session === undefined || token === undefined) return undefined;

  const { request } = token;
  if (request.session !== session) return undefined;
  const age = now - request.issuedAt;
  if (fresh && (age > TOKEN_AGE || age < -TOKEN_SKEW)) return undefined;

  const ok = await verified(token, session);
  return ok ? token : undefined;
}

// An edit session's peer may read everything but other peers' inboxes, and publish its own
// broadcasts as its rights allow: batches and histories with `propose`, assets with `edit`.
function editorGrant(peer: KeyId, rights: readonly Right[]): RelayGrant {
  const proposes = rights.includes("propose");
  return {
    publish: [
      `peer/${peer}`,
      `inbox/*/${peer}`,
      ...(proposes ? [`peer/${peer}/batches`, `peer/${peer}/history/*`] : []),
      ...(rights.includes("edit") ? [`asset/${peer}`] : []),
    ],
    subscribe: ["source", "asset/*", "peer/**", `inbox/${peer}/*`],
  };
}

// What a token's peer may do in its session: a watch session's rights are `view`, the owner's
// every right.
function rightsOf(token: Token): readonly Right[] {
  if (token.kind === "editor") return token.grant.rights;
  return token.kind === "owner" ? RIGHTS : ["view"];
}

function grantOf(token: Token): RelayGrant {
  const { peer } = token.request;
  if (token.kind === "source") return sourceGrant(peer);
  if (token.kind === "peer") return peerGrant(peer);
  const grant = editorGrant(peer, rightsOf(token));
  if (token.kind === "editor") return grant;
  grant.publish.unshift("source");
  return { publish: grant.publish, subscribe: ["**"] };
}

/**
 * What a connection dialed at `path` with `query` may do, or undefined if its token admits
 * nothing. A new connection's token must be fresh at `now`; a connection already admitted keeps
 * what it was given (`fresh` false).
 */
export async function authorize(
  path: string,
  query: string | undefined,
  now: number,
  fresh = true,
): Promise<RelayGrant | undefined> {
  const token = await checked(path, query, now, fresh);
  return token === undefined ? undefined : grantOf(token);
}

/**
 * A connection whose token checked out: the relay's id for it, its session and peer, the token's
 * kind (`source` and `peer` in a watch session, `owner` and `editor` in an edit session) and
 * the rights it carries, `view` alone in a watch session. An editor's `grant` says in its `by`
 * who gave those rights: the project key, or the peer key of the person whose agent this peer is. A
 * grant from an invite names no one, so an app that needs to know who holds it asks in its own way.
 */
export type Connection = {
  id: string;
  session: KeyId;
  peer: KeyId;
  role: "peer" | "source" | "editor" | "owner";
  rights: readonly Right[];
  grant?: Grant;
};

/**
 * An admitted connection the relay closed: its id, why, and the bytes the relay counted to and
 * from its peer over its whole life. The relay counts bytes only over QUIC, and reports zeros for
 * a connection it closes as `refused`, `expired`, `invalid` or `dropped`, so a connection over
 * another transport, or closed for one of those reasons, has no `bytes`.
 */
export type Ended = { id: string; reason?: string; bytes?: { toPeer: number; fromPeer: number } };

/**
 * The app's say in who the relay admits, beyond what the keys allow
 * (docs/architecture.md#admission).
 * The package keeps no state for it: an app that counts connections keeps them by `id`.
 */
export type Admission = {
  /** Whether to admit a connection whose token checked out, asked on `connect` and `revalidate`. */
  admit?: (connection: Connection) => boolean | Promise<boolean>;
  /** Told when the relay closes an admitted connection; one refused on `connect` gets no `end`. */
  end?: (ended: Ended) => void | Promise<void>;
};

const status = (code: number) => new Response(null, { status: code });

// The reasons moq-relay gives for closing a connection itself, which it reports with zero bytes
// whatever the connection moved.
const RELAY_CLOSED = new Set(["refused", "expired", "invalid", "dropped"]);

// moq-relay reports bytes as `{ sent, received }` from its own side, so `sent` is what it sent to
// the peer. It counts them only over QUIC (WebTransport included) and reports zeros otherwise.
function endOf(id: string, { reason, transport, bytes }: Record<string, unknown>): Ended {
  const ended: Ended = { id };
  if (typeof reason === "string") ended.reason = reason;
  const counts = bytesOf(bytes);
  const counted = transport === "quic" && !RELAY_CLOSED.has(String(reason));
  if (counted && counts !== undefined) ended.bytes = counts;
  return ended;
}

function bytesOf(value: unknown): Ended["bytes"] {
  if (!isRecord(value)) return undefined;
  const { sent, received } = value;
  const counts = [sent, received].every((n) => Number.isSafeInteger(n) && Number(n) >= 0);
  return counts ? { toPeer: Number(sent), fromPeer: Number(received) } : undefined;
}

/**
 * The auth server, as a `fetch` handler for moq-relay's `--auth-url`: it answers each request
 * the relay posts about a session with a grant, or 403. A failure in `admission` answers 500,
 * which refuses a new connection, leaves an admitted one to be asked again, and is only logged
 * for an `end`.
 */
export function createAuthServer(admission: Admission = {}) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return status(405);

    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return status(400);
    }

    if (!isRecord(body) || typeof body.path !== "string" || typeof body.id !== "string") {
      return status(400);
    }

    const { id, event, path } = body;
    const query = typeof body.query === "string" ? body.query : undefined;

    if (event === "end") {
      try {
        await admission.end?.(endOf(id, body));
      } catch {
        return status(500);
      }

      return status(204);
    }

    if (event !== "connect" && event !== "revalidate") return status(400);

    let token: Token | undefined;

    // A token that breaks the check refuses, as one that fails it does, not as a server error.
    try {
      token = await checked(path, query, Date.now(), event === "connect");
    } catch {
      token = undefined;
    }

    if (token === undefined) return status(403);
    const { session, peer } = token.request;
    const grant = grantOf(token);
    const connection: Connection = { id, session, peer, role: token.kind, rights: rightsOf(token) };
    if (token.kind === "editor") connection.grant = token.grant;
    let admitted: boolean | undefined;

    try {
      admitted = await admission.admit?.(connection);
    } catch {
      return status(500);
    }

    return admitted === false ? status(403) : Response.json(grant);
  };
}

/** The auth server that admits every connection whose token checks out. */
export const authServer = createAuthServer();

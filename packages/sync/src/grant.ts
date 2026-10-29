// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Grants in an edit session (docs/architecture.md#rights-and-grants). A grant is checked against
// its chain alone, so any peer, and the relay's auth server, decides the same from the grant.

import { isRecord } from "./chat";
import { base64url, keyId, sign, signedBy, isKeyId, type KeyId } from "./crypto";

export type Right = "view" | "propose" | "edit";

/** Every right, in the order a grant lists them. Each one needs the one before it. */
export const RIGHTS: readonly Right[] = Object.freeze(["view", "propose", "edit"]);

export type Grant = {
  session: KeyId;
  rights: Right[];
  /** The key it is given to; absent only in an invite, which whoever holds it may use. */
  to?: KeyId;
  /** The key that signed it: the project key, or a peer passing on its own rights. */
  by: KeyId;
  /** When `by` is a peer: the grant that gave it these rights. */
  chain?: Grant;
  sig: string;
};

const encoder = new TextEncoder();

type Fields = {
  session: KeyId;
  rights: Right[];
  to?: KeyId | undefined;
  by: KeyId;
  chain?: Grant | undefined;
  sig: string;
};

// A grant with its fields in order, without `to` or `chain` when it has none.
function ordered({ session, rights, to, by, chain, sig }: Fields): Grant {
  if (to === undefined) {
    return chain === undefined ? { session, rights, by, sig } : { session, rights, by, chain, sig };
  }

  return chain === undefined
    ? { session, rights, to, by, sig }
    : { session, rights, to, by, chain, sig };
}

// The bytes a grant's signature covers: its canonical JSON without `sig`, fields in order.
const grantBytes = ({ session, rights, to, by, chain }: Omit<Fields, "sig">) =>
  encoder.encode(`snowy grant v1\n${JSON.stringify({ session, rights, to, by, chain })}`);

/**
 * A grant of `rights` in `session`, signed by `signer`: the project key's, or a peer's passing on
 * rights from `chain`, the grant it holds. Leave out `to` only for an invite. Rejects with a
 * `TypeError` for what every reader would refuse: a value that isn't a right, rights that leave
 * out one another needs, such as `edit` without `propose`, a session or `to` that isn't a key
 * id, or a `chain` that isn't a grant or is already 2 long.
 */
export async function signGrant(
  signer: CryptoKeyPair,
  fields: { session: KeyId; rights: Right[]; to?: KeyId; chain?: Grant },
): Promise<Grant> {
  const { session, to } = fields;
  const rights = signableRights(fields.rights);
  if (!isKeyId(session) || (to !== undefined && !isKeyId(to)))
    throw new TypeError("the session and `to` must be key ids");
  const chain = signableChain(fields.chain);
  const by = await keyId(signer.publicKey);
  const sig = await sign(signer.privateKey, grantBytes({ session, rights, to, by, chain }));
  return ordered({ session, rights, to, by, chain, sig: base64url(sig) });
}

function signableRights(given: Right[]) {
  if (!given.every((r) => RIGHTS.includes(r)))
    throw new TypeError(`rights ${given.join(", ")} aren't all rights`);
  const rights = readRights(RIGHTS.filter((r) => given.includes(r)));
  if (rights === undefined)
    throw new TypeError(`rights ${given.join(", ")} need the ones before them`);
  return rights;
}

// Read back, so it is signed as every verifier reads it whatever key order the caller's copy has.
function signableChain(given: Grant | undefined) {
  if (given === undefined) return undefined;
  const chain = readGrant(given);
  if (chain === undefined) throw new TypeError("the chain isn't a grant");
  if (chain.chain !== undefined) throw new TypeError("a chain is at most 2 grants long");
  return chain;
}

// Rights in their one canonical spelling, a prefix of `RIGHTS`: `view`, then `view` and `propose`,
// then all three.
function readRights(value: unknown): Right[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > RIGHTS.length) return undefined;
  // copy: the grant's own rights, neither the caller's array nor the frozen RIGHTS.
  const rights = RIGHTS.slice(0, value.length);
  return rights.every((r, i) => value[i] === r) ? rights : undefined;
}

const FIELDS = new Set(["session", "rights", "to", "by", "chain", "sig"]);

/**
 * A grant from untrusted JSON in canonical shape, or undefined, checked for shape only: its
 * signatures are `verifyGrant`'s. A chain is at most 2 grants long.
 */
export const readGrant = (value: unknown) => readGrantAt(value, 0);

// A grant at `depth` in a chain; one already in a chain can't carry another.
function readGrantAt(value: unknown, depth: number): Grant | undefined {
  if (!isRecord(value) || Object.keys(value).some((k) => !FIELDS.has(k))) return undefined;
  const { session, to, by, sig } = value;
  const rights = readRights(value.rights);
  const chain = value.chain === undefined || depth > 0 ? undefined : readGrantAt(value.chain, 1);
  const chained = value.chain === undefined || chain !== undefined;
  const keys = isKeyId(session) && isKeyId(by) && (to === undefined || isKeyId(to));
  const valid = keys && rights !== undefined && chained && typeof sig === "string";
  return valid ? ordered({ session, rights, to, by, chain, sig }) : undefined;
}

const grantSigned = (grant: Grant) => signedBy(grant.by, grant.sig, grantBytes(grant));

/**
 * Whether a grant gives its rights in `session`. It does if the project key signed it, or if a
 * peer signed it with a `to` and its `chain` is a valid project-key grant to that peer, or an
 * invite, holding every right it passes on. It reads the grant back first, so a grant parsed
 * with its keys in another order checks the same, and one in no shape at all gives nothing.
 */
export async function verifyGrant(grant: Grant, session: KeyId): Promise<boolean> {
  const read = readGrant(grant);
  return read !== undefined && verifyRead(read, session);
}

async function verifyRead(grant: Grant, session: KeyId): Promise<boolean> {
  if (grant.session !== session) return false;
  if (grant.by === session) return grant.chain === undefined && grantSigned(grant);

  const { chain, to, rights, by } = grant;
  if (chain === undefined || to === undefined || chain.by !== session) return false;
  const passedOn = chain.to === undefined || chain.to === by;
  if (!passedOn || !rights.every((r) => chain.rights.includes(r))) return false;

  const checks = await Promise.all([grantSigned(grant), verifyRead(chain, session)]);
  return checks.every(Boolean);
}

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Grants in an edit session (docs/architecture.md#rights-and-grants): the project key gives a
// key, or anyone holding an invite, rights in the project, and a peer passes some of its own on
// to an agent. A grant is checked against its chain alone, so any peer, and the relay's auth
// server, decides the same from the grant itself.

import { isRecord } from "./chat";
import { base64url, keyId, sign, signedBy, isKeyId, type KeyId } from "./crypto";

/** What a grant lets its holder do in a project. */
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

// A grant's fields in order, without `to` or `chain` when it has none.
const ordered = (
  session: KeyId,
  rights: Right[],
  to: KeyId | undefined,
  by: KeyId,
  chain: Grant | undefined,
): Omit<Grant, "sig"> => ({
  session,
  rights,
  ...(to === undefined ? {} : { to }),
  by,
  ...(chain === undefined ? {} : { chain }),
});

// The bytes a grant's signature covers: its canonical JSON without `sig`, fields in order.
const grantBytes = ({ session, rights, to, by, chain }: Omit<Grant, "sig">) =>
  encoder.encode(`snowy grant v1\n${JSON.stringify({ session, rights, to, by, chain })}`);

/**
 * A grant of `rights` in `session`, signed by `signer`: the project key's, or a peer's passing on
 * rights from `chain`, the grant it holds. Leave out `to` only for an invite. Throws for rights
 * that leave out one another needs, or a chain that isn't a grant.
 */
export async function signGrant(
  signer: CryptoKeyPair,
  fields: { session: KeyId; rights: Right[]; to?: KeyId; chain?: Grant },
): Promise<Grant> {
  const rights = readRights(RIGHTS.filter((r) => fields.rights.includes(r)));
  if (rights === undefined)
    throw new TypeError(`rights ${fields.rights.join(", ")} need the ones before them`);
  // Signed as every verifier reads it back, whatever shape the caller's copy has.
  const chain = fields.chain === undefined ? undefined : readGrant(fields.chain);
  if (fields.chain !== undefined && chain === undefined)
    throw new TypeError("the chain isn't a grant");
  const by = await keyId(signer.publicKey);
  const grant = ordered(fields.session, rights, fields.to, by, chain);
  const sig = await sign(signer.privateKey, grantBytes(grant));
  return { ...grant, sig: base64url(sig) };
}

// Rights in their one spelling: the first of RIGHTS and any after it, each needing the one
// before, so `view` alone, then with `propose`, then with `edit`.
function readRights(value: unknown): Right[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > RIGHTS.length) return undefined;
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
  return valid ? { ...ordered(session, rights, to, by, chain), sig } : undefined;
}

const grantSigned = (grant: Grant) => signedBy(grant.by, grant.sig, grantBytes(grant));

/**
 * Whether a grant gives its rights in `session`: signed by the project key, or by a peer that
 * names its holder in `to` and passes on no more than the valid project grant in its `chain`
 * gives the peer, as its `to` or as an invite. It reads the grant back first, so a grant parsed
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

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Grants in an edit session (src/grant.ts), in Chromium: the project key's grants and invites
// give their rights, a peer passes on at most its own to a key it names, and anything forged,
// widened, misplaced or too long gives nothing; a grant reads back, and checks, in any key order.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { generateKeyPair, keyId } from "../src/crypto";
import { readGrant, signGrant, verifyGrant, type Grant, type Right } from "../src/grant";
import { rejection } from "./support/rejection";

async function setup() {
  const project = await generateKeyPair();
  const person = await generateKeyPair();
  const agent = await generateKeyPair();
  const [session, personId, agentId] = await Promise.all([
    keyId(project.publicKey),
    keyId(person.publicKey),
    keyId(agent.publicKey),
  ]);
  return { project, person, agent, session, personId, agentId };
}

// A 3-long chain, which `signGrant` won't sign. Readers refuse its shape before any signature,
// so the stand-in `sig` is never checked.
const overChain = (chained: Grant, agentId: string, to: string): Grant => ({
  session: chained.session,
  rights: ["view"],
  to,
  by: agentId,
  chain: chained,
  sig: chained.sig,
});

// Rights as plain JavaScript might pass them, without the type's check.
function unchecked(values: string[]): Right[] {
  const rights: Right[] = [];
  Object.assign(rights, values);
  return rights;
}

// A grant as it arrives: JSON, read back.
const roundTrip = (grant: Grant) => readGrant(JSON.parse(JSON.stringify(grant)));

test("the project key's grant to a key, and its invite, give their rights", async () => {
  const { project, session, personId } = await setup();
  const [toPerson, invite] = await Promise.all([
    signGrant(project, { session, rights: ["view", "propose", "edit"], to: personId }),
    signGrant(project, { session, rights: ["view"] }),
  ]);
  expect(invite.to).toBeUndefined();
  const read = [roundTrip(toPerson), roundTrip(invite)];
  expect(read).toEqual([toPerson, invite]);
  const checks = await Promise.all([verifyGrant(toPerson, session), verifyGrant(invite, session)]);
  expect(checks).toEqual([true, true]);
});

test("a peer passes on some of its rights to an agent, from its own grant or an invite", async () => {
  const { project, person, session, personId, agentId } = await setup();
  const [own, invite] = await Promise.all([
    signGrant(project, { session, rights: ["view", "propose", "edit"], to: personId }),
    signGrant(project, { session, rights: ["view", "propose"] }),
  ]);
  const [fromOwn, fromInvite] = await Promise.all([
    signGrant(person, { session, rights: ["view", "propose"], to: agentId, chain: own }),
    signGrant(person, { session, rights: ["view"], to: agentId, chain: invite }),
  ]);
  expect([roundTrip(fromOwn), roundTrip(fromInvite)]).toEqual([fromOwn, fromInvite]);
  const checks = await Promise.all([fromOwn, fromInvite].map((g) => verifyGrant(g, session)));
  expect(checks).toEqual([true, true]);
});

test("a peer can't pass on more than it holds, someone else's grant, or an invite of its own", async () => {
  const { project, person, agent, session, personId, agentId } = await setup();
  const [viewer, toAgent] = await Promise.all([
    signGrant(project, { session, rights: ["view"], to: personId }),
    signGrant(project, { session, rights: ["view", "propose"], to: agentId }),
  ]);
  const grants = await Promise.all([
    signGrant(person, { session, rights: ["view", "propose"], to: agentId, chain: viewer }),
    signGrant(person, { session, rights: ["view"], to: personId, chain: toAgent }),
    signGrant(person, { session, rights: ["view"], chain: viewer }),
    signGrant(person, { session, rights: ["view"], to: agentId }),
    signGrant(agent, { session, rights: ["view"], to: agentId, chain: viewer }),
  ]);
  const checks = await Promise.all(grants.map((g) => verifyGrant(g, session)));
  expect(checks).toEqual(grants.map(() => false));
});

test("a grant gives nothing in another session, or once anything it signs is changed", async () => {
  const { project, person, session, personId, agentId } = await setup();
  const other = await setup();
  const own = await signGrant(project, { session, rights: ["view"], to: personId });
  const [elsewhere, chained, chainedElsewhere] = await Promise.all([
    signGrant(other.project, { session: other.session, rights: ["view"], to: personId }),
    signGrant(person, { session, rights: ["view"], to: agentId, chain: own }),
    // Passed on over this project's grant, but naming another project.
    signGrant(person, { session: other.session, rights: ["view"], to: agentId, chain: own }),
  ]);
  const grants: Grant[] = [
    elsewhere,
    { ...own, rights: ["view", "propose"] },
    { ...own, to: agentId },
    { ...chained, chain: { ...own, rights: ["view", "propose"] } },
    { ...own, chain: own },
    { ...chained, chain: { ...own, session: other.session } },
    chainedElsewhere,
    // The peer's own signature no longer covers whom it passes its rights to.
    { ...chained, to: personId },
    { ...own, by: personId },
  ];
  const checks = await Promise.all(grants.map((g) => verifyGrant(g, session)));
  expect(checks).toEqual(grants.map(() => false));
});

test("a peer's own signature over a chain it forged gives nothing", async () => {
  const { project, person, session, personId, agentId } = await setup();
  const own = await signGrant(project, { session, rights: ["view"], to: personId });
  // The project key's grant with rights it never signed, under the peer's valid signature.
  const forged: Grant = { ...own, rights: ["view", "propose", "edit"] };
  const grants = await Promise.all([
    signGrant(person, { session, rights: ["view", "propose", "edit"], to: agentId, chain: forged }),
    signGrant(person, { session, rights: ["view"], to: agentId, chain: { ...own, sig: "" } }),
  ]);
  const checks = await Promise.all(grants.map((g) => verifyGrant(g, session)));
  expect(checks).toEqual([false, false]);
});

test("a grant reads only in canonical shape, with a chain at most 2 long", async () => {
  const { project, person, session, personId, agentId } = await setup();
  const own = await signGrant(project, { session, rights: ["view", "propose"], to: personId });
  const chained = await signGrant(person, { session, rights: ["view"], to: agentId, chain: own });
  const tooLong = overChain(chained, agentId, personId);
  const values = [
    undefined,
    "grant",
    { ...own, rights: [] },
    { ...own, rights: ["propose", "view"] },
    { ...own, rights: ["view", "view"] },
    { ...own, rights: ["view", "edit"] },
    { ...own, rights: ["edit"] },
    { ...own, rights: ["viewer"] },
    { ...own, rights: ["view", "propose", "edit", "edit"] },
    { ...own, session: "not a key" },
    { ...own, to: "not a key" },
    { ...own, extra: 1 },
    { ...own, sig: 1 },
    { ...chained, chain: "grant" },
    tooLong,
  ];
  expect(values.map((v) => readGrant(v))).toEqual(values.map(() => undefined));
  // A peer's grants record holds several, read in one pass.
  expect([own, chained].map(readGrant)).toEqual([own, chained]);
});

test("a chain longer than 2, or one on the project key's own grant, gives nothing", async () => {
  const { project, person, session, personId, agentId } = await setup();
  const own = await signGrant(project, { session, rights: ["view"], to: personId });
  const chained = await signGrant(person, { session, rights: ["view"], to: agentId, chain: own });
  const tooLong = overChain(chained, agentId, personId);
  const projectChained = await signGrant(project, {
    session,
    rights: ["view"],
    to: personId,
    chain: own,
  });
  const checks = await Promise.all([tooLong, projectChained].map((g) => verifyGrant(g, session)));
  expect(checks).toEqual([false, false]);
});

// An object with its keys in reverse order, as another peer's JSON might spell it.
const reversed = (value: object) => Object.fromEntries(Object.entries(value).toReversed());

test("a grant checks out whatever key order it arrives in", async () => {
  const { project, person, session, personId, agentId } = await setup();
  const own = await signGrant(project, { session, rights: ["view", "propose"], to: personId });
  const chained = await signGrant(person, { session, rights: ["view"], to: agentId, chain: own });
  // Every key reversed, the chain's too.
  const arrived: Grant = JSON.parse(JSON.stringify({ ...reversed(chained), chain: reversed(own) }));
  expect(Object.keys(arrived.chain ?? {})[0]).toBe("sig");
  const valid = await verifyGrant(arrived, session);
  expect(valid).toBe(true);
});

test("a grant is signed only with each right's predecessor, and with its chain as it reads back", async () => {
  const { project, person, session, personId, agentId } = await setup();
  const own = await signGrant(project, { session, rights: ["view", "propose"], to: personId });
  const errors = await Promise.all([
    rejection(signGrant(project, { session, rights: ["edit"], to: personId })),
    rejection(signGrant(project, { session, rights: ["view", "edit"], to: personId })),
    rejection(
      signGrant(person, { session, rights: ["view"], to: agentId, chain: { ...own, rights: [] } }),
    ),
  ]);
  expect(errors.map((e) => e instanceof TypeError)).toEqual([true, true, true]);
  // The holder's copy of its grant, in another key order, as an app might keep it.
  const { sig, by, to, rights, session: s } = own;
  const reordered = { sig, by, to: to ?? personId, rights, session: s };
  const chained = await signGrant(person, {
    session,
    rights: ["view"],
    to: agentId,
    chain: reordered,
  });
  const read = roundTrip(chained);
  expect(read).toEqual(chained);
  const valid = await verifyGrant(chained, session);
  expect(valid).toBe(true);
});

test("a grant every reader would refuse isn't signed", async () => {
  const { project, person, agent, session, personId, agentId } = await setup();
  const own = await signGrant(project, { session, rights: ["view"], to: personId });
  const chained = await signGrant(person, { session, rights: ["view"], to: agentId, chain: own });
  const errors = await Promise.all([
    rejection(signGrant(project, { session, rights: unchecked(["view", "admin"]), to: personId })),
    rejection(signGrant(agent, { session, rights: ["view"], to: personId, chain: chained })),
    rejection(signGrant(project, { session, rights: ["view"], to: "not a key" })),
    rejection(signGrant(project, { session: "not a key", rights: ["view"] })),
  ]);
  expect(errors.map((e) => e instanceof TypeError)).toEqual([true, true, true, true]);
});

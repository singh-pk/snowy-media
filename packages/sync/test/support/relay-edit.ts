// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The relay tests' edit-session scenario (test/support/relay-worker.ts): bare MoQ connections,
// each announcing what its token's rights may or may not allow, and one watching what the relay
// lets through.

import * as Moq from "@moq/net";
import { generateKeyPair, keyId, type KeyId } from "../../src/crypto";
import { signGrant, type Right } from "../../src/grant";
import { editorToken, ownerToken } from "../../src/relay-auth";
import type { RelayConfig } from "./relay-worker";
import { watch } from "./watch";

type Bare = { session: KeyId; token: string; paths: string[]; seen?: (path: string) => void };

// A bare connection that announces `paths`, in order, beside what `connectRelay` publishes, and
// hands `seen` every broadcast path the relay announces to it.
async function bare(config: RelayConfig, { session, token, paths, seen = () => undefined }: Bare) {
  const local = new Moq.Origin.Producer();
  const remote = new Moq.Origin.Producer();
  for (const path of paths) local.createBroadcast(Moq.Path.from(...path.split("/"))).announce();
  const url = new URL(`${config.url.replace(/\/$/, "")}/snowy/${session}`);
  url.searchParams.set("token", token);
  const connection = await Moq.Connection.connect({
    url,
    webtransport: {
      serverCertificateHashes: [
        { algorithm: "sha-256", value: Uint8Array.fromBase64(config.hash) },
      ],
    },
    websocket: { enabled: false },
    publish: local.consume(),
    consume: remote,
  });

  void announced(remote, seen);
  return connection;
}

// Hands `seen` each broadcast the relay announces as active, for as long as it announces any.
async function announced(remote: Moq.Origin.Producer, seen: (path: string) => void) {
  for await (const update of remote.announced(Moq.Path.Pattern.parse("**"))) {
    if (Moq.Announce.isActive(update.kind)) seen(String(update.prefix));
  }
}

// A new peer key with a grant of `rights` from the project key, and the token it dials with.
async function editPeer(project: CryptoKeyPair, session: KeyId, rights: Right[]) {
  const pair = await generateKeyPair();
  const id = await keyId(pair.publicKey);
  const grant = await signGrant(project, { session, rights, to: id });
  const token = await editorToken(grant, pair);
  return { id, token };
}

// Edit-session rights at the relay: a peer with `view` alone can't publish batches, histories,
// assets or `source`, which is the owner's; one with `propose` publishes batches but not assets;
// one with `edit` publishes assets. The watcher holds `view` and publishes nothing, so whatever
// it sees came from the others. The relay may announce one connection's broadcasts in any order,
// so once everything allowed is seen a last peer connects, and the watcher looks once it has seen
// that one. Then the owner announces `source`, to show the watcher would have seen a leaked one.
export async function editRights(config: RelayConfig) {
  const project = await generateKeyPair();
  const session = await keyId(project.publicKey);
  const peers = await Promise.all([
    editPeer(project, session, ["view"]),
    editPeer(project, session, ["view"]),
    editPeer(project, session, ["view", "propose"]),
    editPeer(project, session, ["view", "propose", "edit"]),
  ]);
  const [{ token: watcherTok }, { id: viewerId, token: viewerTok }] = peers;
  const [, , { id: proposerId, token: proposerTok }, { id: editorId, token: editorTok }] = peers;
  const seen = new Set<string>();
  const watching = watch();
  const watcher = await bare(config, {
    session,
    token: watcherTok,
    paths: [],
    seen: (path) => {
      seen.add(path);
      watching.changed();
    },
  });
  const others = await Promise.all([
    bare(config, {
      session,
      token: viewerTok,
      paths: [
        `peer/${viewerId}/batches`,
        `peer/${viewerId}/history/main`,
        `asset/${viewerId}`,
        "source",
        `peer/${viewerId}`,
      ],
    }),
    bare(config, {
      session,
      token: proposerTok,
      paths: [
        `asset/${proposerId}`,
        `peer/${proposerId}/batches`,
        `peer/${proposerId}/history/main`,
        `peer/${proposerId}`,
      ],
    }),
    bare(config, { session, token: editorTok, paths: [`asset/${editorId}`, `peer/${editorId}`] }),
  ]);
  const allowed = [
    `peer/${viewerId}`,
    `peer/${proposerId}`,
    `peer/${proposerId}/batches`,
    `peer/${proposerId}/history/main`,
    `asset/${editorId}`,
    `peer/${editorId}`,
  ];
  await watching.until(() => allowed.every((p) => seen.has(p)));
  const { id: lastId, token: lastTok } = await editPeer(project, session, ["view"]);
  const lastPeer = await bare(config, { session, token: lastTok, paths: [`peer/${lastId}`] });
  await watching.until(() => seen.has(`peer/${lastId}`));
  const published = [...seen]
    .filter((path) => path !== `peer/${lastId}`)
    .map((path) =>
      path.replaceAll(viewerId, "V").replaceAll(proposerId, "P").replaceAll(editorId, "E"),
    )
    .toSorted();
  const owner = await generateKeyPair();
  const ownerTok = await ownerToken(project, owner);
  const ownerPeer = await bare(config, { session, token: ownerTok, paths: ["source"] });
  await watching.until(() => seen.has("source"));
  for (const connection of [watcher, ...others, lastPeer, ownerPeer]) connection.close();
  return published;
}

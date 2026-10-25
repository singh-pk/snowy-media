# Agent guide: @snowy-media/sync

The [root AGENTS.md](../../AGENTS.md) applies here too; this file adds what is specific to this package. Paths below are relative to `packages/sync/`.

This package runs live sessions over one transport. In a watch session, a local file is streamed from one source to a group, with shared chat and per-viewer audio and subtitles; it plays through `@snowy-media/engine`, using only its public exports. In an edit session, people and agents edit one `@snowy-media/timeline` project, whose objects sync carries as opaque bytes without depending on that package. Read [docs/architecture.md](docs/architecture.md) before changing it; code follows that design, and a change to the design changes that document in the same pull request.

## Commands

| Task | Command |
| --- | --- |
| Tests (Chromium) | `bun run test` |
| Typecheck | `bun run typecheck` |

The relay tests (`test/relay.test.ts`) start a MoQ relay in Docker. On Colima, start it with `colima start --network-address`, since it doesn't forward UDP ports to this machine.

## Map

| Path | What it holds |
| --- | --- |
| `src/crypto.ts` | key pairs and key ids, Ed25519 signatures, the content key, and sealing objects with AES-GCM |
| `src/chunk.ts` | the media chunk: its signed header and packet records, encoded and checked |
| `src/signed-record.ts` | the source's records as JSON signed by the session key, over a domain prefix and the session |
| `src/catalog.ts` | the catalog and each track's codec setup, as signed records |
| `src/control.ts` | the control record: the source's playback position and state from a moment on its clock |
| `src/source-records.ts` | the source's records as a peer holds them: the newest catalog and control record and each track's setup, sealed as they came |
| `src/state-requests.ts` | getting the session's state on join: asking the source or the best-ranked peer for the source's records, and answering such asks |
| `src/hlc.ts` | the hybrid logical clock that orders chat |
| `src/chat.ts` | chat messages in canonical bytes, their hash chain, and signed checkpoints |
| `src/chat-log.ts` | the chat log: shared order, gaps, version vectors, and edits, deletes and reactions applied |
| `src/chat-batch.ts` | the chat batch: an author's queued messages and checkpoint, sealed as one object |
| `src/chat-sender.ts` | sending this peer's chat: chaining each message, and batching whenever the stream is free |
| `src/chat-receiver.ts` | receiving chat batches from tracks, repairs and this peer: into the log, the holdings and gap repair |
| `src/chat-holdings.ts` | what a peer holds of each author's chat, one checkpoint per run, to answer repairs and version vectors |
| `src/chat-repairs.ts` | asking for missing chat: one ask per author, moved to the next ranked peer on `gone` or a closed link |
| `src/chat-requests.ts` | the chat repair messages between peers, checked, and the side that answers them |
| `src/chat-session.ts` | a peer's chat in one session: the store, log, sending, receiving and repair, wired to its links |
| `src/chat-store.ts` | chat in the local store: an append-only OPFS log per author, read back after a reload |
| `src/link.ts` | the link to one peer that both transports give, so nothing else refers to either |
| `src/relay-auth.ts` | relay authorization: the join grant, peers' and the source's tokens, and the auth server moq-relay asks, with the app's admission |
| `src/relay.ts` | the connection to the relay over MoQ, through `@moq/net`: presence, this peer's tracks, subscriptions, and a `Link` to each peer |
| `src/opfs.d.ts` | types for OPFS sync access handles, which TypeScript's DOM library lacks |
| `src/rank.ts` | ranking peers by hash, so every asker picks alike and different questions spread out |
| `test/` | unit tests (`*.unit.ts`), run in Chromium by `unit.test.ts`; browser tests (`*.test.ts`), such as the relay tests, which need Docker; `test/support/` holds what they share |

## Rules

1. **Event-driven only.** No `setTimeout` or `setInterval`, and no polling. Every action responds to a transport, engine, store or user event; the transports' keepalives are the only clocks.
2. **One writer per object.** Never add an object that two peers write.
3. **The relay stores nothing.** Never rely on it keeping an object after forwarding it.
4. **Transports stay behind `Link`.** The scheduler, the store and chat never refer to MoQ or WebRTC directly.
5. **Authorization checks keys, not plans.** `src/relay-auth.ts` decides only what signatures and grants allow. Limits on who may join or edit beyond that, and accounts, are the app's policy; the app applies it through `admit` ([Admission](docs/architecture.md#admission)), and the package never gains the policy itself.

## Review

Beyond the rules above and [docs/architecture.md](docs/architecture.md), a reviewer checks:

- **Shortest path.** A chunk comes from where [Choosing where each chunk comes from](docs/architecture.md#choosing-where-each-chunk-comes-from) says, in its order; a change to that order changes the document first.
- **Relay first.** The relay, over WebTransport, is the path for every peer that can reach it; a direct WebRTC link is a shortcut on top. ICE uses the two STUN endpoints only, a pair whose ICE check fails stays on the relay, and `symmetric` peers never use WebRTC. No change makes a session depend on a direct link or on a server the design doesn't have, such as TURN. Networks that block UDP are outside the design.
- **Least data.** Each byte crosses each link once: nothing is sent twice, a record goes out only when it changes, a request no longer needed is cancelled, and metadata reaches only the peers that use it. The exceptions are the design's: the source sends a chunk again to a peer no forwarder can serve, and peers republish what they publish after a relay restart. An encoding on a path that carries every chunk is compact, and each field earns its bytes. A test of something that sends asserts how much it sent.
- **Highest quality.** Nothing lowers bitrate, resolution or frame rate to save bytes or to keep up; a slow peer is served from elsewhere or waits (root rule 10).

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
| `src/chunk.ts` | the media chunk: its signed header and packet records, encoded and checked, and sealed under its object key |
| `src/signed-record.ts` | the source's records as JSON signed by the session key, over a domain prefix and the session |
| `src/catalog.ts` | the catalog and each track's codec setup, as signed records |
| `src/chunk-cutter.ts` | cutting a file's packets into chunks as the demuxer reads them: video at keyframes at least 2 s apart, other tracks by pts along the video's bounds |
| `src/chunk-recut.ts` | cutting a past chunk again at the source: from the chunk before, joined to the header first signed and sealed, or nothing when the file no longer gives that body |
| `src/chunk-index.ts` | the chunk index: where each chunk cut so far begins, in signed pages of 64 chunks, joined, and the chunk covering a time |
| `src/control.ts` | the control record: the source's playback position and state from a moment on its clock |
| `src/source-cut.ts` | the source's cut of its file: each chunk signed once and its header kept, with its sealed size, each index reported once all its tracks are kept, carrying on after a reload |
| `src/source-index.ts` | the source's chunk index: its pages built from each index cut, and which to publish next, the page still filling once per burst and a full page once |
| `src/source-records.ts` | the source's records as a peer holds them: the newest catalog and control record, each track's setup and each page of the chunk index, sealed as they came |
| `src/state-requests.ts` | getting the session's state on join: asking the source or the best-ranked peer for the source's records, and answering such asks |
| `src/chunk-requests.ts` | the chunk request messages between peers, checked, and a forwarder's side that answers them, one chunk at a time on each link, most urgent first |
| `src/chunk-links.ts` | a peer's chunk traffic on its links: the plan's requests sent, replies and delivered chunks taken into the plan and the store, and other peers' requests answered |
| `src/fetch-plan.ts` | where each chunk comes from: which link to ask, by expected finish while it has room, and what to cancel or move to the source as replies, links and deadlines change |
| `src/have.ts` | have ranges: what a forwarder holds, sealed and checked, published once per burst of store changes, and each forwarder's newest as a peer keeps them |
| `src/push-queue.ts` | what the source sends next: seek targets, then requests, then chunks ahead of the playhead up to the push horizon, then background requests; and its answers to peers' requests, holding at most 4 from each |
| `src/source-sender.ts` | the source's sending: each chunk the push queue picks, live or to the peer that asked, as fast as its stream takes it, and peers' requests on its links into the queue |
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
| `src/chunk-store.ts` | media chunks in the local store: one OPFS file per chunk, sealed as it came, with each one stored or evicted reported |
| `src/link.ts` | the link to one peer that both transports give, so nothing else refers to either |
| `src/grant.ts` | edit-session grants: the project key's to a key or an invite, passed on to agents, signed and checked against their chain |
| `src/relay-auth.ts` | relay authorization: the join grant, peers', the source's and edit sessions' tokens, and the auth server moq-relay asks, with the app's admission |
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
- **Least data.** Each byte crosses each link once: nothing is sent twice, a record goes out only when it changes, a request no longer needed is cancelled, and metadata reaches only the peers that use it. The exceptions are the design's: the source sends a chunk again to a peer that asks for one no connected forwarder holds, or an urgent one its forwarder has sent nothing of and would deliver after its deadline; the page of the chunk index still filling goes again as it grows; and peers republish what they publish after a relay restart. An encoding on a path that carries every chunk is compact, and each field earns its bytes. A test of something that sends asserts how much it sent.
- **Work follows events.** An event's work is bounded by what it changed: no sweep of a whole window or film per event, no queue without a bound. [What each event costs](docs/architecture.md#what-each-event-costs) says what each event may do.
- **Highest quality.** Nothing lowers bitrate, resolution or frame rate to save bytes or to keep up; a slow peer is served from elsewhere or waits (root rule 10).

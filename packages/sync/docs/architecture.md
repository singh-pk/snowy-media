# Architecture

How @snowy-media/sync is built. It runs two kinds of session over one transport:

- **Watch sessions:** one person plays a local media file to a group of viewers, everyone shares a chat, and each viewer picks their own audio and subtitle tracks.
- **Edit sessions:** people and agents edit one `@snowy-media/timeline` project together. Each person's media stays on their own disk, and it is streamed from there to the others ([Edit sessions](#edit-sessions)).

Everything up to [Edit sessions](#edit-sessions) describes watch sessions. Edit sessions reuse it, and that section says what differs. For using the package, start with the [README](../README.md).

## Contents

1. [Principles](#principles)
2. [Infrastructure](#infrastructure)
3. [Platform baseline](#platform-baseline)
4. [Package boundaries](#package-boundaries)
5. [Identity, sessions and access](#identity-sessions-and-access)
6. [Roles](#roles)
7. [Track layout](#track-layout)
8. [Objects](#objects)
9. [Local store](#local-store)
10. [Interests and retention](#interests-and-retention)
11. [Media at the source](#media-at-the-source)
12. [Media delivery](#media-delivery)
13. [Peer groups](#peer-groups)
14. [Playback control](#playback-control)
15. [Audio and subtitle choice](#audio-and-subtitle-choice)
16. [Chat](#chat)
17. [Presence and membership](#presence-and-membership)
18. [Edit sessions](#edit-sessions)
19. [Events](#events)
20. [The relay](#the-relay)
21. [Security](#security)
22. [Session lifecycle](#session-lifecycle)
23. [Requirements on @snowy-media/engine](#requirements-on-snowy-mediaengine)
24. [Constants](#constants)
25. [Limits](#limits)
26. [Testing](#testing)

## Principles

| Principle | Meaning |
| --- | --- |
| **Local-first** | Every peer keeps its own copy of what its interests cover; the source reads from its file. The interface reads only from local data, never from the network. Losing the network loses nothing that was already received. |
| **One writer per object** | Each object has exactly one author: the source writes media, control and the catalog, and each peer writes its own chat and records. In an edit session, each asset's source writes that asset's media, each author writes their own timeline batches, and the active sequencer writes a branch's history. Two peers never write the same object, so nothing needs merging. |
| **Event-driven** | Snowy's code has no timers and polls nothing. Every action responds to an event from the transport, the engine, the store or the user. The only clocks are the transports' keepalives and the engine's media clock, and both reach Snowy as events. |
| **Each byte crosses each link once** | No peer receives the same object twice. The source pushes each chunk to the relay once. It sends a chunk again only to a peer that asks for one no connected forwarder holds, or an urgent one its forwarder has sent nothing of and would deliver after its deadline. The page of the [chunk index](#chunk-index) still filling is the one record sent again as it grows, at most 64 chunks' worth. |
| **Metadata goes only to those who need it** | What a forwarder holds goes to its group, and a receiver's capability record goes to the source. Records are sent when they change, never repeated. |
| **A stateless relay** | The relay forwards objects and forgets them. It stores nothing and runs no timers. Peers are the only storage. |
| **One code path** | Every peer runs the same logic. Roles come from measured values and user settings, never from browser or device detection. |

## Infrastructure

| Piece | Purpose | Requirement |
| --- | --- | --- |
| **Relay** | Fans out objects, carries signaling, and is the route for peers that can't connect directly | Speaks MoQ Transport over WebTransport, keeps no objects after forwarding them, and authorizes connections with tokens signed by the session key, through an auth server that keeps no state ([Authorization](#authorization)) |
| **STUN, two endpoints** | Lets peers learn their public address for WebRTC, and classify their NAT | Two endpoints on different IP addresses |
| **Static hosting** | Serves the app | Sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` |

Nothing else exists. There is no TURN server, signaling server, database, account system, token service or any per-session state on a server.

## Platform baseline

The engine's baseline, plus:

| Feature | Used for |
| --- | --- |
| WebTransport | The connection to the relay |
| `RTCPeerConnection` and `RTCDataChannel` | Direct links inside a peer group |
| Origin Private File System (OPFS) | Media chunks and logs in the local store |
| IndexedDB | Non-extractable `CryptoKey`s and the source's file handle in the local store |
| File System Access: a persisted `FileSystemFileHandle` | The source reading its file across reloads |
| Web Crypto: Ed25519, AES-GCM, HKDF, SHA-256 | Signatures, encryption, deriving keys, content hashes |
| `navigator.storage.persist()` | Keeping the local store from being evicted |

`createSync` checks all of them once and rejects with an `UnsupportedPlatformError` naming the first one missing. Nothing else checks for features.

## Package boundaries

- `@snowy-media/sync` is its own package, under the Snowy License ([LICENSE.md](../../../LICENSE.md)).
- It uses `@snowy-media/engine` only through the engine's public exports.
- The engine knows nothing about networks. It plays packets from whatever packet source it is given ([Requirements on @snowy-media/engine](#requirements-on-snowy-mediaengine)).
- Both transports sit behind one `Link` interface. The scheduler, store and chat never refer to MoQ or WebRTC directly.
- **Consumers** (the player, the editor) decide what is fetched and kept, through [interests](#interests-and-retention). The sync package applies no retention policy of its own.
- **Timeline content is opaque.** In an edit session, sync carries `@snowy-media/timeline`'s batches, entries and terms as bytes, with the few fields it needs to order and repair them, given by the consumer. It never parses or applies them, and it doesn't depend on the timeline package ([Edit sessions](#edit-sessions)).
- **Export belongs to the consumer.** The sync package knows no container formats and never writes to the user's files. It exposes chunks in order through `sync.read(track, fromUs)`, an async iterator that waits for each chunk's `stored` event and ends after the last chunk (`catalog.chunkCount`). The editor remuxes them with `@snowy-media/ffmpeg` and writes the file itself.

```ts
type Link = {
  peer: PeerId;
  send(message: Message): void;              // control messages: have, request, busy, …
  deliver(key: ObjectKey, bytes: Uint8Array): void;
  on(event: "message", handler: (value: unknown) => unknown): void;   // parsed, not yet checked
  on(event: "object", handler: (key: ObjectKey, bytes: Uint8Array) => unknown): void;
  on(event: "close", handler: () => unknown): void;
  close(): void;
};
```

- A link is to one peer, and the transport opens it: over the relay's inbox tracks, or a direct connection's data channels. The peer's chat tracks are subscribed outside it.
- Its `close` event fires once, whichever end closed it. Nothing arrives after it, including what was on its way.
- A peer may have two links open at once, the relay's and a direct one. A request is answered on the link it came on, and an ask goes on the newest link, with its cancel or urgent re-ask on the link it went out on, whose end holds it. When any of a peer's links closes, what was asked of that peer moves on to the next candidate; if the reply comes anyway on another link, the first answer fills the gap.

## Identity, sessions and access

### Keys

| Key | Type | Held by | Purpose |
| --- | --- | --- | --- |
| **Peer key** | Ed25519 key pair, one per device per session | Every peer, the source included | Identifies the peer and signs its capability records, chat checkpoints and relay requests. `PeerId` is the base64url public key. |
| **Session key** | Ed25519 key pair | The source | Signs the catalog, the chunk index, chunk headers, control records and join grants, and authenticates the source to the relay. `SessionId` is the base64url public key. In an edit session it is the project key, held by the owner, and signs only grants and the project record ([Edit sessions](#edit-sessions)). |
| **Session secret** | 32 random bytes | Everyone with the invite | HKDF derives the content encryption key from it |

Private keys are generated non-extractable and kept in IndexedDB ([Local store](#local-store)).

### Invite link

```text
https://<app>/watch#v=1&relay=<relay URL>&s=<SessionId>&k=<session secret>&g=<join grant>
```

- Everything sits in the URL **fragment**, which browsers never send to any server, the static host included.
- Anyone with the link can join. The link *is* the access model.

### Join grant

A join grant is signed by the session key, so viewers can join while the source is offline.

```ts
type JoinGrant = {
  session: SessionId;
  rights: "viewer";
  sig: string;                // Ed25519 by the session key
};
```

The grant's signature covers `snowy join v1\n` followed by the JSON `{ session, rights }`.

A peer's relay token is the grant plus a request the peer signs with its own key: the JSON `{ peer, session, issuedAt }`, with `issuedAt` in milliseconds, after `snowy relay v1\n`. The relay's auth server checks both signatures and lets that peer publish only under its own namespaces ([Authorization](#authorization)).

The source's token is the same request, signed by the source's peer key as above and by the session key after `snowy source v1\n`. It grants `source` plus everything a peer may publish under the source's own `PeerId`.

A token is the unpadded base64url of its JSON (`{ kind: "peer", grant, request, sig }` or `{ kind: "source", request, sig, sessionSig }`, and in an edit session `editor` or `owner`, [Rights and grants](#rights-and-grants)), sent as the `token` query parameter of the URL the peer dials. It admits a connection for 5 minutes after `issuedAt`, so a peer makes one each time it connects. Only the request ages: the join grant inside never expires, as in the invite link.

## Roles

| Role | Who | Uploads |
| --- | --- | --- |
| **Source** | The peer with the file. A watch session has exactly one; in an edit session, each asset has one ([Asset sources](#asset-sources)). It reads chunks from its [file](#the-sources-file) and stores none. | Every chunk once to the relay; control; the catalog and chunk index; chunks asked for when no forwarder holds them |
| **Forwarder** | A peer that meets every rule for becoming a forwarder (below) | Chunks to the peers in its group |
| **Receiver** | Every other peer | No media. Its own chat and records only. |

Every peer, the source included, sends and receives chat and has a `PeerId`.

### How each peer assesses itself

Each peer works out its own role from values it can measure:

| Input | How it's obtained |
| --- | --- |
| **NAT class** | Gather server-reflexive candidates against both STUN endpoints. The same public port from both → `cone`. Different ports → `symmetric`. |
| **Upload capacity** | **Probe:** on join, and when the user turns Share my upload on, the peer publishes a probe of one second of `sessionBitrate` (at most 2 MB) on `peer/<self>/probe`, which only it subscribes to. Capacity is the probe's size divided by the time from first byte written to last byte received back. **While forwarding:** bytes acknowledged per second over each completed delivery replace the probe value. |
| **Visibility** | `document.visibilityState`, from the `visibilitychange` event |
| **Willingness** | The user setting **Share my upload**. Asked when a peer first joins, with nothing preselected. There is no device-based default. |

The NAT test doesn't detect port-restricted filtering. A pair that passes it but can't connect finds out from the ICE result ([Signaling](#signaling)).

**Becomes a forwarder** when *all* of the following hold:

- `nat` is `cone`
- Share my upload is on
- the tab is visible
- `measuredUpload × 0.6 ≥ sessionBitrate`, so the peer has at least one slot

**Stops forwarding** when *any* of the following happens:

- `measuredUpload < sessionBitrate`
- the tab becomes hidden
- the user turns Share my upload off

Becoming a forwarder and stopping happen at different upload levels (1.67× and 1× the session bitrate), so a peer near one value doesn't switch back and forth.

**Slots** (the number of peers a forwarder serves at once):

```text
slots = floor(measuredUploadKbps × 0.6 / sessionBitrateKbps)
```

`sessionBitrateKbps` is the video bitrate, plus the bitrates of the audio tracks being pushed, plus the subtitle tracks, all from the catalog.

### Capability record

```ts
type Caps = {
  peer: PeerId;
  version: number;             // increases on every change, kept in the local store
  role: "source" | "forwarder" | "receiver";
  nat: "cone" | "symmetric";
  slots: number;               // 0 unless forwarder
  freeSlots: number;
  audio: number;               // selected audio track id
  wants: "window" | "full";    // "full" while any of its interests is a background one
  rttToRelayMs: number;
  sig: string;                 // Ed25519 by the peer key
};
```

A capability record is signed by the peer, so it can be passed on by others. It is published only when one of its fields changes. Where it goes depends on the role:

- **The source and forwarders** publish on `peer/<self>/caps`, which every peer subscribes to, so receivers can find forwarders.
- **Receivers** send theirs to the source only, on `inbox/<source PeerId>/<self>/ctl`. The source needs their `audio` and `wants`.

## Track layout

Every name sits under the namespace `snowy/<SessionId>`. The relay enforces who may publish each one.

| Namespace / track | Publisher | Subscribers | Content |
| --- | --- | --- | --- |
| `source` / `catalog` | Source | All | [Catalog](#catalog) |
| `source` / `control` | Source | All | [Control record](#control-record) |
| `source` / `init/<track>` | Source | All | Codec setup for one media track |
| `source` / `index` | Source | All | [Chunk index](#chunk-index) |
| `source` / `media/<track>` | Source | Forwarders and receivers without a forwarder | Media chunks for video, audio and subtitle tracks |
| `peer/<PeerId>` / `caps` | The source and forwarders | All | Capability record |
| `peer/<PeerId>` / `chat` | That peer | All | Chat messages and checkpoints |
| `peer/<PeerId>` / `have` | Forwarders | That forwarder's group | What chunks the forwarder holds |
| `peer/<PeerId>` / `probe` | That peer | That peer only | The upload probe |
| `inbox/<recipient>/<sender>` / `ctl` | The sender | The recipient | Requests, replies, signaling, clock sync, receivers' capability records |
| `inbox/<recipient>/<sender>` / `deliver` | The sender | The recipient | Objects sent on request |

### Mapping to MoQ

- One media chunk is one MoQ group with one object, sent on its own QUIC stream.
- One chat message, or one batch of messages, is one group with one object.
- `catalog`, `control`, `index` and `caps` publish a new group for every new version. A subscriber keeps only the newest; for `index`, the newest of each page.
- Priorities, highest first: `control`, then `inbox`, then `chat`, then `catalog`, `index`, `caps` and `have`, then `init`, then `media` (subtitle, then audio, then video), then `probe`.
- **The client is [`@moq/net`](https://www.npmjs.com/package/@moq/net)**, pinned to an exact release. At setup it negotiates either moq-lite or an IETF MoQ Transport draft (14 to 22) with the relay, though telling a refused subscription apart relies on moq-lite's track information; the relay this package is tested against is moq-dev's [`moq-relay`](https://github.com/moq-dev/moq), the same project's, which picks moq-lite. A peer connects to the session's root, `snowy/<SessionId>`, under the relay's URL, so every path below is relative to it, and a relay can authorize a connection by the path it dialed.
- **A peer serves its own tracks.** It announces a broadcast (MoQ Transport's namespace) and answers the subscriptions the relay forwards to it; nothing is pushed with `PUBLISH`, which moq-relay doesn't accept.
- **Each sender has a broadcast of its own** under `inbox/<recipient>`, so every broadcast has exactly one publisher, and a relay never has to choose between two.
- **Every object is a group of its own**, inbox messages included, so one lost or slow object never holds up another. Objects on the relay may therefore arrive in any order: everything sent through it is either self-proving (batches, chunks) or answered whatever order it comes in (repair messages).
- **An object's key travels with it** on `chat`, `deliver`, `catalog`, `control`, `init/<track>`, `index` and `media/<track>`, framed as a 2-byte big-endian key length, the key in UTF-8, then the sealed bytes. A message on `ctl` is JSON.
- **Presence** is a watch of the announcements under `peer/*` (`SUBSCRIBE_NAMESPACE` in MoQ Transport): a peer is online while its `peer/<PeerId>` broadcast is announced, and the relay reports the announcements and withdrawals.
- **A broadcast's tracks exist before it is announced**, so a peer that subscribes on seeing a broadcast finds every track in it. A peer creates its own tracks before announcing `peer/<PeerId>`, so they are fixed when it connects, and the source announces `source` before that, so a peer that sees the source online finds `source` too.
- **No group is skipped for its age.** `@moq/net` skips a group once a newer one is further ahead in time than the subscriber allows, which suits live media; every frame here carries the same timestamp, so none ever is.
- **A link over the relay** opens at each end once it has subscribed to both tracks of `inbox/<self>/<peer>` and heard anything on them. An end sends nothing before it has both of its own subscriptions, so whatever arrives proves the other end can hear this one. Each end sends a `link-open` message after subscribing, and answers with one more when it opens on hearing the other first, since a message sent before the other end subscribed may not be delivered. As objects arrive in any order, what arrives before the link opens is kept and handed on, in order, once it does. The link closes when either end withdraws its inbox broadcast or the peer's `peer/<PeerId>` broadcast is withdrawn, and at an end whose subscription the relay ends.
- **A subscription may begin with the last few seconds of groups**, which the publisher keeps for subscribers that come later, as a relay may too. Nothing relies on them: everything is self-proving or answered whatever order it comes in, and what a peer missed before that comes through repair.

## Objects

| Object | Key | Writer | Size | Authenticated by |
| --- | --- | --- | --- | --- |
| Catalog | `catalog@version` | Source | About 1 KB | Session-key signature |
| Control record | `control@epoch` | Source | About 100 B | Session-key signature |
| Codec setup | `init/<track>` | Source | Under 1 KB | Session-key signature |
| Chunk index page | `index/<page>@n` | Source | Up to about 1.4 KB: 64 chunks | Session-key signature |
| Media chunk | `media/<track>/<index>` | Source | One GOP: typically 1–5 MB for video, tens of KB for audio and text subtitles, up to a few MB for bitmap subtitles | Signed chunk header |
| Chat batch | `chat/<author>/<firstSeq>-<lastSeq>` | Author | About 150 B per message | Hash chain plus a signed checkpoint |
| Capability record | `caps/<peer>@version` | That peer | About 150 B | Peer-key signature |
| Have ranges | `have/<peer>@n` | That forwarder | Tens of bytes | Relay authorization |

Every object is encrypted.

### Encryption

- **Content key:** `HKDF-SHA256(sessionSecret, salt = SessionId, info = "snowy content v1")`, used as an AES-256-GCM key. An edit session derives one per sealing peer instead ([Encryption in an edit session](#encryption-in-an-edit-session)).
- **Nonce:** 96 random bits from `crypto.getRandomValues` for every encryption, sent in front of the ciphertext. The nonce never depends on the object key, so a replaced object, a re-sent batch or a lost counter can't reuse one. At the session's scale, random 96-bit nonces stay far below the AES-GCM limit of 2³² encryptions per key.
- **Associated data:** the object key, so ciphertext can't be moved to a different key.
- In a watch session, peers store and forward the **encrypted bytes unchanged**, and decrypt only to read. One key seals everything, so bytes forwarded unchanged open under it whoever sent them. An object a peer builds from what it holds, such as a chat repair reply, it seals itself.
- The relay sees only encrypted data, plus the track names and sizes.

### Catalog

```ts
type Catalog = {
  version: number;
  durationUs: number;
  tracks: Array<{
    id: number;
    kind: "video" | "audio" | "subtitle";
    codec: string;               // WebCodecs codec string, or the subtitle format
    bitrateKbps: number;
    language?: string;
    title?: string;
  }>;
  chunkCount?: number;           // set once demuxing has reached the end of the file
  sig: string;
};

type CodecSetup = {              // init/<track>: what the track's decoder is configured with
  track: number;
  codec: string;
  description?: string;          // WebCodecs `description` (extradata), unpadded base64url
  codedWidth?: number;
  codedHeight?: number;
  sampleRate?: number;
  numberOfChannels?: number;
  sig: string;
};
```

- **Both are JSON signed by the session key.** `sig` covers a domain prefix (`snowy catalog v1` or `snowy init v1`, then a newline) and the JSON of `{ session, …fields }`: the `SessionId`, then the record's fields in the order above, absent ones left out, as the join grant names its session too. The prefix means a signature over one kind of record can't pass for another, or for anything else the session key signs.
- **A peer checks every field** and refuses a record with a field nobody signed, a `description` in another base64url spelling, or two tracks with one `id`. Track ids are 0 to 65535, as in chunk headers.
- **The object key names what it holds:** a catalog is `catalog@<version>` and a codec setup `init/<track>`, and a peer refuses one whose content doesn't match its key. As the key is the encryption's associated data, a sealed catalog can't be passed off as another version either.
- Versions count up from 1, and a peer keeps the catalog with the highest. The tracks, and each one's codec setup, are fixed for the session: a later version only adds `chunkCount`. Every record is signed, so a peer can take one from anyone.
- **A peer holds each record sealed as it came:** the newest catalog, the newest control record, each track's codec setup and each page of the [chunk index](#chunk-index), which it passes on unchanged to a joiner. As a track's setup is fixed, a peer keeps the first and ignores any later one. The source holds its own records the same way, taking each one it publishes.

### Media chunk

```text
ChunkHeader (signed, plaintext inside the encrypted object)
  version      u8      1 in a watch session, 2 in an edit session
  session      SessionId
  asset        [32]    version 2 only: the AssetId
  signer       PeerId  version 2 only: the source that cut the chunk
  track        u16
  index        u32
  startUs      i64     inclusive, the pts of the chunk's keyframe
  endUs        i64     exclusive, the startUs of the next chunk
  count        u32     packets
  bodyHash     SHA-256 of the body
  sig          Ed25519 over every field above: by the session key (version 1), or by `signer` (version 2)
Body
  count × PacketRecord, in decode order
    ptsUs       i64
    dtsUs       i64
    durationUs  u32
    flags       u8      bit 0: keyframe
    size        u32
    bytes       [size]
```

- Timestamps are in microseconds for every track, so every track shares one timeline.
- A version 2 header names the project, the asset and the source, so a chunk can't be replayed into another project, asset or source. A peer stores one only if `signer` is the source named in the chunk's namespace and holds `edit`.
- **On the wire,** a chunk is sealed under its object key, in a watch session `media/<track>/<index>` (an edit session's are in [Media keys](#media-keys)), spelled in decimal without leading zeros, which travels with it. A peer opens it under that key, then checks that the header names the same slot, so a chunk can't be passed off as another, sealed again or not.
- A peer stores a chunk only once the signature and `bodyHash` both check out. It throws away anything that fails without storing it.

### Chunk index

```ts
type IndexPage = {
  page: number;                  // lists chunks from page × 64
  bounds: number[];              // the page's chunk i is [bounds[i], bounds[i + 1]), in microseconds
  bytes: number[];               // the page's chunk i of video is bytes[i] long, sealed
};
```

- **Why it exists:** interests are time ranges, but chunks are asked for and advertised by index, and a chunk is as long as the file's keyframes make it. A peer learns a chunk's times from its header only once it holds the chunk, so without the index a joiner or a seek couldn't tell which chunk covers a moment.
- **One list for every track,** since an index is the same time range in each. Each chunk ends where the next begins, so `n` chunks take `n + 1` numbers, increasing; a moment before the first chunk counts as covered by it.
- **Sizes let a peer plan in bytes.** A chunk's length in time follows the file's keyframes, and its size follows the bitrate too, from hundreds of KB to tens of MB. Video is most of a moment's bytes, so each chunk's sealed video size, listed beside its bounds, tells a peer what asking for it costs before the first byte arrives ([Choosing where each chunk comes from](#choosing-where-each-chunk-comes-from)). A chunk of another track costs the video size × that track's `bitrateKbps` ÷ the video's, from the catalog. The page's sizes are signed with its bounds, and a page whose `bytes` doesn't hold one positive whole number per chunk is refused.
- **It comes in pages of 64 chunks,** each a signed record like the catalog, under the prefix `snowy index v1`, keyed `index/<page>@<n>` for the `n` chunks it lists. The page number is signed with the bounds, so a page can't be passed off as another. A page only grows as the source cuts, until it is full, so a peer keeps the one listing the most of each, and the source keeps no counter: it builds each page from the chunk headers and sizes it already keeps.
- **Pages join from the first:** a peer reads the index as page 0, then each next page that starts where the one before ends, up to the first that isn't full. Whether every chunk is cut is the catalog's `chunkCount`: once it is set and the index lists that many, a moment past the last chunk counts as covered by the last.
- **The source publishes the page still filling as it cuts,** when its stream will accept more, so a burst of cuts becomes one update, as with [have ranges](#have-ranges). A full page never goes again. That page is the one record that repeats bytes a peer already has, and pages bound it: an update is at most about 1.4 KB, and at one update per cut the index costs about 790 bytes a chunk in all, sealed and framed, so some 3 MB for a two-hour film in 2-second chunks.
- **A peer holds each page sealed as it came** and passes them on to a joiner with the other records. What isn't listed yet waits for the next page. A session has no index before its first chunk is cut, so the [whole state](#presence-and-membership) needs none, but it does need every page before the last one held: a full page never goes again, so a peer holding page `p` whose pages don't join up to it missed one, doesn't hold the whole state, and asks for it again, as a joiner does. A joiner that has the state before any page places its interests once one arrives on `index`.

## Local store

```text
OPFS  snowy/<SessionId>/
        catalog            newest catalog
        control            newest control record
        init/<track>
        chunk-index/<page> each page of the chunk index listing the most chunks
        media/<track>/<index>
        chat/<author>      append-only log: one record per message, and the checkpoints that prove them
        peers/<PeerId>     newest caps record of each known peer
        counters           this peer's caps version
        meta               this session's onEnd
        index/<track>      the source only: every signed chunk header it has cut, in index order, each with its sealed size
        fingerprint        the source only: size, lastModified, SHA-256 of its file's first and last MiB
IDB   snowy-keys / <SessionId>
        peer               this device's peer key pair (non-extractable)
        content            the content key (non-extractable), so kept chunks stay readable after the session
        content/<PeerId>   edit sessions: the key of each source whose chunks it keeps, instead (non-extractable)
        session            the session key pair (the source only, non-extractable)
        file               the source's FileSystemFileHandle (the source only)
```

- Every peer except the source keeps its chunks here, in OPFS, encrypted. The source keeps no chunks, only their signed headers.
- **A chunk is kept sealed as it came,** one file per chunk, so a peer forwards the bytes unchanged. It is stored only once it checks out, and one whose key is stored or being stored is thrown away unread. Each file is written through a writable stream, which Chromium writes aside and moves into place on close, so a browser crash leaves a chunk whole or its file empty. The store owns `media/`, and on opening it removes whatever isn't a chunk, such as an empty file or a swap file a crash left. The store is this origin's own, so chunks aren't checked again after a reload.
- `navigator.storage.persist()` is requested when a peer joins.
- **Chat** is kept as one JSON record per line, in a log per author, written through OPFS sync access handles, so the store runs in a dedicated worker. An append counts only once all of it is written and flushed; one that fails is cut back off and leaves its seqs free. A seq already written isn't written again, so the first copy stays, as in the holdings. A received batch is stored before the holdings take it, so one the store fails to take changes nothing. A crash can tear only the end of a log, which is cut off when the store opens: everything from the first line that isn't a record, when no record follows it. A record after a bad line means the log is corrupt, and the store refuses to open rather than drop that record, which could give a seq already published to another message.
- Chat is kept in plaintext: the content key sits in the same origin's IndexedDB, so encrypting it would protect nothing from whoever can read OPFS.
- The checkpoints a peer's holdings drop when runs join stay in the log, which is append-only; on reload, the holdings drop them again.
- **On reload,** the chat logs restore the holdings, the log and the clock: the clock moves past every stored message, nothing restored is marked late, and this peer's own unsent messages stay out of the holdings until their batch comes back. A restore asks for no gaps; the version vector sent on reconnect fills them. This peer's own last message gives the next seq, so there is no chat seq counter: a message is written to the store before it is queued.
- What is kept, and for how long, is decided by [interests](#interests-and-retention).
- The store emits `stored(key)` and `evicted(key)`, which drive the scheduler, what the peer advertises and the consumer.

## Interests and retention

### Interests

A consumer states what it wants as interests. The sync package fetches and keeps exactly what the interests cover:

```ts
type Interest = {
  move(fromUs: number, toUs: number): void;   // e.g. on every `progress` event
  release(): void;
};

sync.interest({
  tracks: "selected" | "all",      // selected: video, the chosen audio, every subtitle track
  fromUs: number,
  toUs: number,
  priority: "urgent" | "ahead" | "background",
  keep: boolean,                   // keep the chunks after the interest moves away or is released
}): Interest;
```

- A chunk is **fetched** while at least one interest covers it, in priority order: `urgent`, then `ahead`, then `background`.
- A chunk is **evicted** when no interest covers it and it was never covered by an interest with `keep: true`.
- `sync.drop(track, fromUs, toUs)` deletes chunks in a range, kept ones included. It is the only way to remove a kept chunk during a session.
- `sync.create(...)` and `sync.join(...)` take `onEnd: "delete" | "keep"`, stored in the session's `meta` and applied when the session ends or the peer leaves.
- With `onEnd: "keep"`, the content key stays in IndexedDB (in an edit session, each source's key whose chunks the peer keeps), so `sync.read` still decrypts the chunks after the session.

### Feedback to the consumer

| Event | Meaning |
| --- | --- |
| `stored(key)` | A chunk is stored |
| `evicted(key)` | A chunk was deleted because no interest covers it |
| `complete(track)` | Every chunk of a track is stored. Needs `catalog.chunkCount`. |
| `storage-full` | A write failed with `QuotaExceededError`, or another error. The chunk isn't stored, the requests that have sent nothing are cancelled, and the scheduler fetches nothing more until an interest changes or a chunk is evicted or dropped. The consumer decides what to release, narrow or drop. |

### Player and editor

| | Player | Editor |
| --- | --- | --- |
| Interests | `ahead`, `selected`, from 2 min behind the playhead (but not before where the peer joined or last seeked) to 15 min ahead, moved on every `progress` event | `background`, `all`, the whole timeline, `keep: true` |
| Urgent window | `urgent`, playhead to playhead + 30 s | The same |
| Clean-up | As the window moves | None during the session |
| `onEnd` | `delete` | `keep` |
| Export | None | Remuxes from `sync.read` into a file the user picks with `showSaveFilePicker()`, writing each chunk in order as it is stored |

Players and editors can be in the same session: interests belong to each peer.

### Where a joiner starts

- A joiner reads `control`, finds the chunk containing the current position in the [chunk index](#chunk-index), and places its interests there.
- A player never fetches what was played before it joined, unless the viewer seeks back. Its window starts at the playhead and grows back to 2 min behind as playback goes on.
- An editor fetches from the playhead onwards first, then fills the rest of the film at background priority: from the playhead to the end, then from the start.

## Media at the source

### The source's file

- The source picks its file with `showOpenFilePicker()` and keeps the `FileSystemFileHandle` in IndexedDB. It never copies the file.
- **After a reload,** the source calls `queryPermission({ mode: "read" })` on the handle. If permission was dropped, the *Resume sharing* button calls `requestPermission()`, which needs that click.
- Before resuming, the source checks the file against the `fingerprint` in its local store. If the size, `lastModified`, or either hash differs, the file has changed on disk, and the source refuses to resume. Resuming would sign different data under the same chunk indexes.
- The source stores **no chunks**, only the signed header of every chunk it has cut, and the sealed size of each chunk, which the [chunk index](#chunk-index) lists for video. The headers survive a reload, so indexes and boundaries never change and nothing is signed twice.
- **Cutting a past chunk again:** the source seeks the demuxer to the previous chunk's `startUs` (the file's start for index 0), demuxes forward, and cuts as it first did, from that chunk's keyframe, which it finds by its pts. Every chunk after it comes out as it first did, by the rules in [Demuxing and cutting chunks](#demuxing-and-cutting-chunks). Seeking one chunk early catches audio and subtitle packets stored in the file before the video keyframe.
- Before sending a chunk cut again, the source checks its body against `bodyHash` in the stored header. On a mismatch, it replies `gone` to the requester and reports `file-changed` to its consumer, never sending a chunk that wouldn't verify. A chunk it would push live is skipped instead, and a peer that misses it asks.

### Demuxing and cutting chunks

1. The source opens the file from its handle with the engine's demuxer.
2. **Video:** a chunk spans at least 2 seconds and closes at the first keyframe after that. Every video chunk starts on a keyframe. Its length is bounded only by the file's keyframe interval, because cutting inside a GOP would stop chunks from decoding on their own.
3. **Leading pictures:** packets stay in decode order with the GOP they belong to. In an open GOP, pictures after the keyframe in decode order but with a pts before `startUs` (such as RASL pictures) stay in that chunk. A peer that starts decoding at a chunk discards every frame with a pts before `startUs`.
4. **Audio and subtitles:** for every video chunk `[startUs, endUs)`, each audio and subtitle track gets a chunk with the same index containing every packet whose `ptsUs` falls in that range and that was read in the window rule 5 gives. The same index means the same time range in every track. A subtitle cue that starts in one chunk and ends in a later one stays in the chunk where it starts.
5. **Packets stored out of place:** a file may store a track's packets away from the video around them. An audio or subtitle chunk takes the packets read from the keyframe that starts the chunk before it (the file's start for index 0), where cutting it again starts reading, until the video closes the chunk after it. A packet stored earlier or later than that, or with a pts before the first chunk, is left out. Video before the first keyframe is left out too, and the last chunk of every track ends where the latest packet in it ends.
6. **Codec setup:** one `init/<track>` object per track holding the codec string, WebCodecs `description` (extradata), coded size, sample rate and channel count.

### Push order

The source keeps a single priority queue. A chunk's priority, highest first:

1. The chunk covering a **seek target**, in every pushed track
2. Chunks a peer has **asked the source for** ([Media delivery](#media-delivery))
3. Chunks **ahead of the playhead**, in time order, up to the **push horizon** (15 min ahead of the playhead). At each index: every subtitle track, then every audio track at least one peer has selected, then video.
4. **Background requests** from peers with `wants: "full"` ([Media delivery](#media-delivery)). These go only when nothing above is queued.

The source sends the next chunk as soon as the relay stream will accept more data (when its writer's `ready` promise resolves). It doesn't wait for playback, so pushing runs as fast as the source's upload. Nothing beyond the push horizon goes on `source/media/<track>`. Peers that want more ask for it, and those chunks go only to them, through `deliver`.

- **A seek target's chunks** are the chunk covering the target in every pushed track. After them, pushing carries on ahead of the target as the new playhead.
- **A chunk goes live once.** One that a seek or a newly selected track would push again isn't pushed again: a peer that missed it asks.
- **What isn't cut yet waits.** Indexes are cut in order as the source demuxes, so a seek past what is cut, or a request for an index not cut yet, waits until cutting reaches it. Once every chunk is cut, a request past the last one is answered `gone`.
- **A peer's requests are queued once each:** a chunk asked for again takes the newer priority, moving up or down, and keeps its place by when it was first asked. A `cancel` takes a request out, and so does the peer leaving.

### Which tracks are pushed

- **Video:** always.
- **Subtitles:** every subtitle track, always. Switching subtitles is then local and immediate.
- **Audio:** every audio track that appears in at least one peer's `caps.audio`. When a selection first appears, that track jumps in the queue from the current playhead. When the last peer stops selecting a track, its chunks stop being pushed.
- Tracks nobody selected reach an editor (`tracks: "all"`) through its background requests, which may name any track.

## Media delivery

### Who subscribes live

| Peer | Media from the relay |
| --- | --- |
| Forwarder | Live subscription to `media/<track>` for video, its selected audio and every subtitle track |
| Receiver with `nat: symmetric` | Live subscription, the same as a forwarder |
| Receiver connected to at least one forwarder | **No live subscription.** Asks for specific chunks only (below). |
| Receiver not connected to any forwarder | Live subscription until a forwarder connects |

### Choosing where each chunk comes from

The scheduler plans in time and bytes. Every chunk an interest covers that the peer doesn't yet hold, found by time in the [chunk index](#chunk-index), has a **deadline** and a **cost**. While playing, the deadline is `now + (chunk start − playhead)`, at normal speed, and now for the chunk holding the playhead; a chunk that ends at or before the playhead has none, and while paused or before playback starts, no chunk has one. The cost is the chunk's sealed size from the index. Every link has a measured **RTT** and **throughput**: a forwarder's from [its data channels](#data-channels), the source's from [its requests](#requests-to-the-source). A chunk's **expected finish** on a link is `rtt + (bytes the link sends before it + its own bytes yet to arrive) / throughput`, where what goes before it is the rest of the chunk on the wire and the requests of the same or higher priority asked earlier, as [a forwarder serves them](#serving-requests).

```text
covered by a live subscription?              → wait for it to arrive
urgent
├─ a connected forwarder advertises it
│     → ask the one that finishes it first, once one of them has room
└─ none does → ask the source, through inbox/<source>/<self>/ctl, once its link has room; while it is offline, wait for a `have` or its `announce`
ahead
├─ a connected forwarder advertises it
│     → ask the one that finishes it first, once one of them has room
└─ none does → wait for the next `have`
background (only while no urgent or ahead request is out), from the playhead to the end, then from the start
├─ a connected forwarder advertises it
│     → ask the one that finishes it first, once one of them has room
└─ none does → ask the source, through inbox/<source>/<self>/ctl, once its link has room, which answers at background priority; while it is offline, wait as above
```

- **A link has room** while fewer than 2 requests are out on it, or while the bytes asked of it and not yet arrived are under its throughput × RTT. A video chunk takes far longer to send than a round trip, so this is normally 2: one chunk arriving and the next already asked, so the link never waits a round trip between chunks. Deeper queues add nothing to throughput, and they delay an urgent chunk behind the ones queued before it. The source link counts the same, so the source holds a few requests from each peer, never a film's worth.
- **Within urgent and within ahead, chunks are placed in start order from the playhead,** which is deadline order; those behind the playhead, such as a player's 2-minute tail, come after every chunk ahead of it.
- **An urgent chunk always has room** on a forwarder link that is full of lower-priority requests: the newest of them that has sent no piece is cancelled to make it, and goes back into the plan.
- **Picking by expected finish spreads the load:** once the fastest forwarder has a chunk queued, the next goes to whichever finishes it first, which may be another.
- **One request per chunk at a time.** A chunk is asked from a second source only after one of these events about the first:

  | Event | Then |
  | --- | --- |
  | `busy` reply | The request ends, but the link gains no room until its next delivery is done; the chunk is placed again by the tree above, that forwarder included once it has room |
  | `gone` reply from a forwarder (it no longer holds it) | Place the chunk again by the tree above, without that forwarder |
  | `gone` reply from the source (past the last chunk, or the file changed) | Leave the chunk out of the plan until a forwarder's `have` lists it |
  | The link's `close` event, or the source going offline | Every request on that link goes back into the plan |
  | A `progress` event finds an urgent request to a forwarder that has sent no piece of it and whose expected finish passes its deadline, while the source is online with room and would finish it sooner | Cancel the forwarder request and ask the source |
  | A chunk asked at a lower priority becomes urgent | Ask the same link again, urgently, so its request moves up |
  | A delivered chunk doesn't check out | As a `gone` reply from that peer |
  | A delivered chunk arrives while another copy of it is being stored | The request ends, and the chunk is placed again |
  | A delivered chunk can't be stored (`QuotaExceededError`, or another write error) | The request ends. Nothing more is placed, and the requests that have sent nothing are cancelled, until the consumer frees or mends storage ([Feedback to the consumer](#feedback-to-the-consumer)) |

- **Requests are cancelled explicitly** with a `cancel` message, so the sender stops sending, such as one whose chunk no interest covers any more. A forwarder that answered `gone` for a chunk isn't asked for it again until its ranges or capability record change.
- **Duplicates can't be stored twice:** a chunk that arrives after the same key was stored is thrown away unread, and its request is cancelled.

### Serving requests

| Message on `ctl` | From | Means |
| --- | --- | --- |
| `{ type: "request", track, index, priority }` | The asker | Send this chunk on `data` (or `deliver`, from the source); `priority` is `urgent`, `ahead` or `background` |
| `{ type: "cancel", track, index }` | The asker | Stop sending it |
| `{ type: "busy", track, index }` | A forwarder, or the source | It has no room for this asker now |
| `{ type: "gone", track, index }` | A forwarder, or the source | It doesn't hold it, or it can't be cut again |

- **A forwarder sends one chunk at a time on each link,** the most urgent first, and the oldest asked first within a priority. A whole chunk arriving soon is worth more to a player than two arriving late, and a seek's chunk then waits for at most the one already on the wire.
- **A forwarder answers `busy`** when a request goes beyond the asker's room, by its own measures of the link (RTT from the connection stats, and throughput as the rate its `data` buffer drains), or when it has no slot for that asker. The two ends measure the link apart, so an asker takes `busy` as an ordinary answer, not a fault.
- **The source holds at most 4 requests from each peer** and answers `busy` beyond them, so its queue stays bounded whatever a peer sends. It counts those waiting in its queue, not one it has begun sending, and a chunk asked for again takes no more room. An urgent request beyond them takes the place of the peer's newest background request, which is answered `busy` instead, so a peer's background requests, sent last, never keep its urgent ones out. An `ahead` request, should one arrive, is queued with the urgent ones.
- A request for a chunk asked before is the same request, with the newer priority; it keeps the time it was first asked.

### What each event costs

The scheduler does no work on a clock, and each event's work is bounded by what it changed, not by the film's length or the session's size:

| Event | Work |
| --- | --- |
| Room on a link (a delivery done, `busy`, `gone`) | Places chunks until no link has room: each priority's scan runs from the playhead, skipping whole ranges held, coming live or, where only a forwarder may be asked, advertised by none, and stops at the first chunk no link can take |
| A link opens, or a forwarder's `caps` change | Places chunks on that link as for room; a forwarder heard from again may be asked for what it answered `gone` to |
| A new page of the chunk index | Places only the newly listed chunks an interest covers |
| `started` / `paused` | Gives the chunks ahead deadlines, or takes them away; nothing is placed or cancelled |
| `storage-full` | Cancels the requests that have sent nothing, and places nothing more until an interest changes or a chunk is evicted or dropped, which places as for room |
| The source's `announce` | Places what waited on the source |
| `have` from a peer | Places only chunks it newly holds that are waiting; none, if it adds nothing waited on |
| `progress` | Checks the deadlines of the urgent requests out, at most a few per link |
| An interest moves or is released | A `move` that leaves its index ranges unchanged does nothing. Otherwise it cancels the requests left uncovered, and the cursors start again from the new ranges |
| A link closes | Puts its requests back into the plan |
| `stored` | Ends its request, or cancels it if the chunk came another way |

- **Interests and holdings are kept as index ranges per track,** as [have ranges](#have-ranges) are, never one entry per chunk, so moving a 15-minute window costs the same as moving a 30-second one.
- **Events in one task are planned once:** each marks the plan stale, and one pass runs in a microtask.
- **A peer's cost follows its group, not the session:** it follows the ranges of at most 4 forwarders and the source, and fan-out to many viewers happens in the relay and in forwarders' slots.

### Requests to the source

- The source answers through `inbox/<requester>/<source>/deliver`, ahead of everything else in its queue except seek targets. It cuts the chunk again from its file ([The source's file](#the-sources-file)).
- **While the source is offline,** urgent chunks that no forwarder holds wait for a `have` event or the source's return. The peer pauses locally when its buffer runs out ([Playback control](#playback-control)).
- The source sends a chunk more than once only in answer to a request: an urgent chunk no connected forwarder holds, or whose forwarder has sent nothing of it and would deliver it after its deadline, and an editor's background chunks that no connected forwarder holds.
- **The source link is measured too:** its RTT is the lowest round trip of the [clock-sync exchanges](#clock-offset), and its throughput is measured over each `deliver` object larger than one 64 KiB piece: the bytes after the first 64 KiB over the time from them to its last byte. Until then it is taken as the session bitrate.

### Have ranges

- What a forwarder holds is a list of index ranges per track: `{ track, ranges: [[start, end], …] }`. A player forwarder usually has one range; an editor may have several while it fills in.
- **A range is `[start, end)`.** Ranges are in order and apart, so each holding has one spelling, and each track appears once, in order. A peer refuses anything else.
- **An update is numbered.** `have/<peer>@n` counts up, and a peer keeps the newest. The same update goes on the forwarder's `have` track and, as a `have` message on `ctl`, to the peers linked to it directly. It isn't signed: on the relay only the forwarder may publish its broadcast, and a direct link is its own. `n` starts from the time the forwarder began publishing, in milliseconds, so it keeps growing across reconnects and reloads, and an old update arriving late on another path never passes for a newer one. A peer forgets a forwarder's ranges when its broadcast is withdrawn.
- The format here is a watch session's; in an edit session, ranges also name the asset and source ([Media keys](#media-keys)).
- On every `stored` and `evicted` event, the forwarder collects the change and publishes a new `have` when the stream will accept more data. Several stores in a burst therefore become one update. The first goes as soon as the stream accepts it.
- Only the forwarder's group subscribes. `have` is not secret, so the relay doesn't restrict who may subscribe.

## Peer groups

### Forming a group

1. A receiver that isn't `symmetric` reads every forwarder's capability record from the session.
2. It sends WebRTC offers, through its inbox tracks on the relay, to up to **8** forwarders that have free slots.
3. When a connection opens, it reads that connection's `currentRoundTripTime` from the connection stats.
4. Once every attempt has either opened or failed, it **keeps the 4 lowest-RTT connections** and closes the rest.
5. Whenever a connection closes, or a forwarder's record changes to `freeSlots: 0`, the receiver tries the next-best forwarder from its candidate list.

Forwarders form groups among themselves the same way, so chunks can move between forwarders when one misses a chunk from the relay.

### Signaling

- Offers, answers and ICE candidates travel as messages on `inbox/<recipient>/<sender>/ctl`.
- ICE servers are the two STUN endpoints only. There is no TURN.
- A pair whose ICE check fails stays relay-only, and neither side retries until one of their capability records changes.
- `symmetric` peers never take part in WebRTC.

### Data channels

Each connection has two data channels:

| Channel | Reliable | Ordered | Carries |
| --- | --- | --- | --- |
| `ctl` | Yes | Yes | `have`, `request`, `cancel`, `busy`, `gone`, and the chat repair messages |
| `data` | Yes | **No** | Chunk pieces |

- A chunk travels in messages of at most 64 KiB, header included. Each header is `{ key, offset, total }`. Because the channel is unordered, one lost piece never delays the pieces after it.
- Sending pauses when `bufferedAmount` reaches 1 MiB and resumes on the `bufferedamountlow` event, with the threshold at 256 KiB.
- RTT is read from the connection stats when the connection opens and again each time a chunk delivery on it completes.
- **Throughput** is measured on each delivery of more than one piece: the bytes after its first piece over the time from its first piece to its last. A delivery of one piece, such as most audio and text subtitle chunks, takes no measurable time, so it changes nothing. Until a link's first delivery, its throughput is taken as the session bitrate, which every forwarder's slot covers ([Roles](#roles)).

## Playback control

### Control record

```ts
type Control = {
  epoch: number;           // increases on every play, pause or seek; kept in the source's local store
  playing: boolean;
  mediaUs: number;         // position at `atUs`
  atUs: number;            // source clock, microseconds
  ended: boolean;
  sequence?: string;       // edit sessions: the sequence it plays, whose time `mediaUs` is
  sig: string;             // by the session key, or in an edit session by the publisher's peer key
};
```

- **Only the source** writes control. Viewers can't play, pause or seek for the group.
- **It is signed like the catalog** ([Catalog](#catalog)), under the prefix `snowy control v1`, and its object key is `control@<epoch>`. Epochs count up from 1, and a peer follows the record with the highest. `sequence` is for edit sessions only: a watch session's record has no other fields. A record that is `ended` isn't `playing`.
- **Clock:** every peer uses `(performance.timeOrigin + performance.now()) × 1000`, wall time in microseconds at high resolution, rounded to whole microseconds as every time in a record is. The measured offset turns the source's `atUs` into the local clock.
- Playback always runs at normal speed. The position a viewer should be at is `mediaUs + (sourceNow − atUs)` while playing, and `mediaUs` while paused.

### Clock offset

- On join, and whenever drift correction finds more than 500 ms of error, the peer measures its clock offset from the source over the inbox tracks. It sends 5 exchanges of `{ t0 }` → `{ t0, t1, t2 }`, each one sent when the previous reply arrives.
- The exchange with the lowest round-trip time gives the offset `((t1 − t0) + (t2 − t3)) / 2`.
- While the source is offline, the last offset stays in use.

### Correcting drift

On every engine `progress` event, a peer compares its playhead to where it should be:

| Error | Action |
| --- | --- |
| Under 40 ms | None |
| 40 ms to 500 ms | Adjust the playback rate by `clamp(error / 2 s, −5%, +5%)` until the error is under 40 ms, then return to 1 |
| Over 500 ms | Frame-exact seek to the target position |

### Commands

- **Play and pause:** the source publishes a control record with `atUs` set **500 ms in the future**. Each peer converts `atUs` to its own clock and hands it to the engine's **scheduled play or pause**, which the engine's media clock carries out at that moment. No Snowy timer is involved, and the engine's `started` or `paused` event confirms it.
- **Seek:** the source publishes the new record with `atUs` 500 ms ahead, and moves the target chunks to the front of its queue. A peer that already holds the target hands the engine a scheduled seek and play at `atUs`. A peer that doesn't seeks as soon as the first target chunk is stored, straight to the position computed from the record. Nobody waits for anybody.

### While the source is offline

- Peers keep following the last control record from their own stores.
- A peer whose next chunk is missing pauses **locally** and shows *Waiting for source*. When that chunk is stored, it seeks to the computed position and carries on.
- When the source comes back, it publishes a new control record with a higher epoch. Every peer follows it.

## Audio and subtitle choice

- **Audio:** each peer picks any audio track in the catalog. Its `caps.audio` tells the source to push that track. Switching:
  1. The peer updates `caps.audio`.
  2. It requests the new track's chunks from the playhead onwards, through the normal [choice of source](#choosing-where-each-chunk-comes-from).
  3. It switches the engine's audio track when the chunk at the playhead is stored.
- **Subtitles:** every subtitle track is pushed to every peer within its interests. Switching or turning them off is local and immediate, with nothing sent over the network.
- All tracks share one timeline, so each peer's choices line up with the control record.

## Chat

### Message

```ts
type ChatMessage = {
  author: PeerId;
  seq: number;              // 1, 2, 3, … per author, kept in the local store
  prev: string;             // SHA-256 of the author's previous message, or "" for seq 1
  hlc: string;              // hybrid logical clock: 16 hex digits, wall ms (48 bits) then counter (16 bits)
  mediaUs: number;          // the sender's playhead when sending; in an edit session, on the sequence it has open
  kind: "text" | "edit" | "delete" | "react";
  target?: { author: PeerId; seq: number };   // the message an edit, delete or reaction applies to
  text?: string;            // text and edit
  emoji?: string;           // react
};
```

- **Canonical bytes:** a message's JSON with its fields in the order above, absent fields left out, as UTF-8. A peer re-encodes every message it parses, so every peer hashes a message the same way. A message with an unknown field, or fields that don't fit its `kind`, is refused.
- **Hashes** (`prev`, a checkpoint's `head`) are the SHA-256 of a message's canonical bytes, as unpadded base64url.
- A `PeerId` has exactly one spelling: one whose unused trailing bits aren't zero is refused, so one author can't have two logs.

### Order

- Every peer sorts messages by `(hlc, author)`, so every peer shows the same order. The HLC is fixed-width, so comparing it as a string compares it as a number.
- The HLC moves forward on every message sent and every message received. A reply therefore always sorts after the message it answers.
- A received HLC more than 60 s ahead of the local wall clock doesn't move the clock; the message is still stored and sorted. A peer with a wrong clock, or a hostile one, can't drag everyone's clock forward.
- A counter past 16 bits carries into the wall-clock part instead of wrapping. A peer stores its clock with its log, so the clock never goes back across a reload.
- A message whose HLC is below the receiving peer's clock when it arrives (because it was written offline) goes into its sorted position and is marked *arrived late*. The mark is local to each peer. Since the clock ignores HLCs too far ahead, one message from the future can't make the ones after it late.

### Edits, deletes and reactions

Chat stays append-only:

- An edit, a delete or a reaction is a **new message** whose `target` names an earlier one, by any author.
- Only the author of a message may edit or delete it. Peers ignore edits and deletes whose `author` differs from `target.author`.
- The latest edit by `(hlc, author)` wins. A delete hides the target and every edit of it.
- Reactions are kept per `(reactor, target, emoji)`. A `react` message with an `emoji` adds it, and one with the same `emoji` and `text: ""` removes it. The latest message for each key wins.

### Sending

- A message is written to the local log first, then sent on `peer/<self>/chat`.
- While the relay stream is busy, new messages queue. When it's free, everything queued goes as one batch object. Batching therefore follows network speed, not a clock.
- A batch is the JSON `{ messages, checkpoint }`, sealed under its key `chat/<author>/<firstSeq>-<lastSeq>`. `messages` holds the author's consecutive messages from `firstSeq` to `lastSeq` in canonical form, and `checkpoint` is the author's checkpoint at `lastSeq`. A batch always empties the queue, so every batch carries one.
- A batch proves itself: a peer accepts one only if its checkpoint verifies and proves every message in it, so a batch checks out whoever forwards it. It proves its messages, not who sealed it: every member holds the content key, so any member can seal a valid batch from an author's messages, such as a sub-range or two batches merged. A batch key's range is never treated as something the author published.
- A batch sealed while the stream closed, even if it has since reopened, goes back to the queue and is sealed again with whatever queued meanwhile.
- Offline, messages queue in the log and are sent when the reconnect event fires.
- After a reload, this peer's own messages after its newest stored checkpoint may never have been published. They are queued again and go with the first batch; a copy a peer already holds is ignored, as the first copy stays.

### Gaps and repair

- A gap is noticed locally: after a batch, the newest held `A` message is above the highest `A` seq held with none missing below it.
- **The peer that has the gap chooses who to ask:** the candidates are the author (if online) and its connected group peers, ranked by `SHA-256(candidate ‖ author ‖ firstMissingSeq)`. It asks the lowest one, then the next if the answer is `chat-gone`, the reply doesn't prove itself or doesn't reach the asked seq, or the link closes. A peer keeps one ask per author; an earlier gap replaces a later one, and a gap the current ask already covers, or that a batch received meanwhile has filled, asks nothing. A gap every candidate failed to fill (`chat-gone`, a bad reply, or one that falls short) is asked again on the next batch from that author only once the candidates change or one of them has closed its link; a candidate whose link closed didn't fail it.
- **What each peer holds to answer:** every author message it has, and for each run of chained seqs, only the checkpoint with the highest seq. Every batch ends at a checkpoint, so an honest author's runs each end at one, and that one checkpoint proves the whole run. When a gap fills and two runs join, the lower run's checkpoint is dropped. Two runs join only where the upper one's first `prev` names the message held below it, and a checkpoint is kept only if its `head` names the message held at its seq, so an author that forks its chain can't make a peer drop the checkpoint that proves what it holds.
- **The answer is a batch**, sealed by the responder from what it holds: from the asked seq to its run's checkpoint. It proves itself like any batch, so the asker takes it through the same path as one from the author's track. A responder that holds the asked seq but not the whole gap answers with what it has; the asker sees the gap now starts later and asks again from there. A responder that doesn't hold the asked seq, or can't prove it or seal the reply, answers `chat-gone`.
- The answer goes only to the peer that asked, on `inbox/<requester>/<responder>/deliver` or over the direct `ctl` channel.
- **The messages** go with the link's `send`, as JSON, and a receiver checks every field before using it:

  | Message | From | Answered with |
  | --- | --- | --- |
  | `{ type: "chat-request", author, firstSeq }` | The peer with the gap | One batch, delivered, or `chat-gone` |
  | `{ type: "chat-gone", author, firstSeq }` | A responder holding none of it it can prove | Nothing: the asker asks the next candidate |
  | `{ type: "chat-versions", versions }` | A reconnecting peer | One batch per run beyond it, delivered; nothing if there are none |

  A delivered batch goes through the asker's receiver like any other, naming the responder, so a reply that doesn't prove itself or falls short moves the ask on.
- **On reconnect**, a peer sends its version vector `{ author: seq }` once to the linked peer ranked first by `SHA-256(peer ‖ self ‖ "chat-versions")`, so reconnecting peers spread over different ones, who replies with one batch per run it holds beyond that, authors the vector doesn't name included. If that peer's last link closes before any batch from it arrives, the vector, as it then is, goes to the next. A peer that holds nothing beyond the vector sends nothing, so the vector may go to the next one later, when that peer leaves; what comes back is then only what is still missing. Each `seq` is the highest held with none missing below it, so the reply also fills older gaps.
- There is no gossip when nothing is missing.

### Authenticity

- Messages arriving on the author's own track are authenticated by the relay's permissions.
- Every message's `prev` hash links it to the author's previous one, forming a chain.
- Each batch ends with a **checkpoint** `{ author, seq, head: SHA-256(message seq), sig }` signed with its peer key. The signature covers `snowy checkpoint v1\n` followed by the JSON `{ author, seq, head }`; the prefix keeps it from passing for anything else the peer key signs.
- A checkpoint proves its own message and each earlier one whose successor's `prev` names it, back to the first missing or mismatched message, or to the newest message already shown. Messages after it wait for a later checkpoint. If repair brings several messages for one seq, only the one the chain names counts. A signature, like a `PeerId`, has exactly one spelling.
- A peer keeps the first message it shows for each `(author, seq)` and ignores any other. An author that sends two messages under one seq may therefore be shown differently by different peers.
- A message received through repair is shown only after its chain checks out against a checkpoint. Until then it's held unshown.

### Display

Message text is rendered with `textContent` only.

## Presence and membership

- **Joining:** a peer is online once its `peer/<PeerId>` namespace is announced on the relay. Peers learn of it through their namespace subscription.
- **Leaving:** the namespace's withdrawal, or the link's `close` event, marks a peer offline. There are no heartbeats.
- **Getting current state on join** (the relay holds none): the joiner asks for `catalog`, `control`, `init/*`, `index` and the forwarders' capability records from the source if it's online. Otherwise it asks the online peer with the lowest `SHA-256(peer ‖ "state")`. Every record is signed, so it can come from any peer.
  - It sends `{ type: "state-request", ask }` on `ctl`, where `ask` counts up with each request and the answer names it. A peer that holds the whole state (a catalog, a control record, the setup of every track in that catalog, and every page of the [chunk index](#chunk-index) before the last it holds) delivers each record it holds unchanged on `deliver`, pages of the index included, with the capability records it holds, then answers `{ type: "state-sent", ask, count }`, where `count` counts the source's records only. A peer that doesn't answers `{ type: "state-gone", ask }`.
  - The joiner asks the next peer on `state-gone`, on a record that doesn't check out, once `count` records have come and the state is still short, and when the asked peer's link closes. `ctl` and `deliver` are separate tracks, so `state-sent` may come before the records: the joiner counts them as they come.
  - The joiner asks no more once it holds the whole state, from whatever path the records came.
  - A peer that comes online during an ask is asked in its turn, and the source next. An ask that runs out of peers ends, and starts again when another peer comes online, asking again peers that failed before, since they may hold more by now.
  - A peer may hand on a record older than the source's newest, which is still the session's own; the source's tracks bring the newer one.

## Edit sessions

An edit session is a live connection to one `@snowy-media/timeline` project. A project outlives its sessions: peers join and leave, and the project goes on in every editor's project folder. Everything above applies, with these differences.

| | Watch session | Edit session |
| --- | --- | --- |
| Session key | Made by the source | The project key, held by the project's owner. `SessionId` is the `ProjectId`. |
| What the session key signs | The catalog, the chunk index, chunk headers, control records and join grants | Grants and the project record only. Everything else is signed by the peer key of whoever publishes it. |
| Media | One file, from the source | Every asset in the project, each from any editor that has its file |
| Media delivery | Pushed ahead, through forwarders and peer groups | Asked for, through the relay ([Asset sources](#asset-sources)) |
| Rights | `viewer` | `view`, `propose`, `edit` ([Rights and grants](#rights-and-grants)) |
| Playback | The source controls everyone's playhead | Each peer has its own playhead, and may follow another's ([Following a playhead](#following-a-playhead)) |
| Shared state | Chat | Chat, grants, asset catalogs, timeline batches, branch histories and presence |
| `onEnd` | Either | `keep` only; `delete` is refused |
| Ends | When the source ends it | Never as a whole: peers leave, and the project stays |

### Rights and grants

```ts
type Grant = {
  session: SessionId;
  rights: Array<"view" | "propose" | "edit">;
  to?: PeerId;                // one key; absent only in an invite
  by: string;                 // the key that signed: the project key, or a PeerId
  chain?: Grant;              // when `by` is a peer: the grant that gave it these rights
  sig: string;                // Ed25519 by `by`
};
```

- **Each right needs the one before it,** so `rights` is `["view"]`, `["view", "propose"]` or `["view", "propose", "edit"]`, spelled in that order: whoever may edit may propose, and whoever may propose may view.
- **An invite** is a grant without `to`, signed by the project key, in the invite link's fragment as in a watch session: `https://<app>/edit#v=1&relay=…&s=…&k=…&g=…`. Whoever holds it has its rights.
- **The owner** gives its own peer key a grant with every right, signed by the project key, so the owner's edits are checked like anyone's.
- **A grant to an agent** is signed by the peer that connects it, names the agent's key in `to`, and carries in `chain` the grant that peer holds.
- **Checking a grant:** its signature covers `snowy grant v1\n` followed by its canonical JSON without `sig`, fields in the order above. It is valid if:
  1. it is signed by the project key, names this session and has no `chain`; or
  2. it is signed by a peer, has a `to`, names this session, and its `rights` are a subset of its `chain`'s; and its `chain` is valid, is signed by the project key, and either names the signer in `to` or is an invite.
  A chain is at most 2 grants long: from the project key to a person, or an invite, then to an agent. `verifyGrant` reads a grant back in canonical shape before checking it, so the key order of the JSON it arrived in doesn't matter.
- **Grants travel with their holders.** Each peer publishes its own grant, and the grants of the agents it carries, on `peer/<self>/grants`, a record that changes only when an agent is connected or disconnected. A peer checks every batch and asset catalog against its author's grant, so a relay that lets something through still can't make anyone accept it.
- **The relay token** in an edit session is `{ kind: "editor", grant, request, sig }`: the grant its peer holds, and the request a watch session's peer signs ([Join grant](#join-grant)). The grant must be valid, and either name the peer in `to` or be an invite; its rights decide what the peer may publish ([Authorization](#authorization)). The owner's token is `{ kind: "owner", request, sig, sessionSig }`, the request signed by the project key after `snowy owner v1\n`, so a watch source's token can't pass for it. `editorToken` and `ownerToken` make them, and `signGrant` and `verifyGrant` in `src/grant.ts` make and check grants.
- **Who sequences isn't a grant.** The timeline's signed project record names it, and sync never checks it ([Timeline batches and histories](#timeline-batches-and-histories)).

### Asset sources

- **Any peer with `edit` whose file matches an asset is a source of it.** It reads the asset from its own `FileSystemFileHandle`, cuts chunks exactly as [Media at the source](#media-at-the-source) describes, and serves them under its own namespace: `asset/<source PeerId>/<AssetId>`. The relay keeps no state, so it can't remember who published an asset first; with the source in the name, the relay can enforce who publishes from the token alone, and two sources of one asset never write the same object.
- An asset's `catalog`, `index`, `init/<track>` and `media/<track>` objects have the formats of a watch session's, **signed by the source's peer key** instead of the session key. A chunk header in an edit session is version 2 ([Media chunk](#media-chunk)).
- Chunks from two sources of one asset are kept apart: a peer fetches a range of an asset from one source, preferring a source it already holds chunks of that asset from, then the lowest RTT. When that source goes, the next one's chunks are fetched for what is still missing.
- **Delivery is by request only, through the relay** (`deliver`). There is no shared playhead to push ahead of, so nothing is pushed, nobody subscribes live to `media`, and forwarders, peer groups and `caps.audio` don't apply. The source answers requests in priority order: `urgent`, then `ahead`, then `background`.
- An asset with no source online can still be edited: the timeline refers to it by its id. Its media plays only from chunks a peer already holds.

### Media keys

Every media object key and store path in an edit session starts with `<source>/<AssetId>/`: `media/<source>/<AssetId>/<track>/<index>` and `index/<source>/<AssetId>/<page>@<n>`. Because the object key is the encryption's associated data, ciphertext can't be moved from one asset or source to another. The calls and events that name a track (`sync.read`, `sync.drop`, `stored`, `evicted`, `complete`, have ranges) name an asset and source as well.

### Interests in an edit session

An interest names an asset as well as tracks and a range: `sync.interest({ asset, tracks, fromUs, toUs, priority, keep })`. The editor places them from the timeline's render plan:

| Interest | Covers | Priority |
| --- | --- | --- |
| Playing | The ranges of each asset the plan uses from the playhead to 30 s ahead | `urgent` |
| The edit | Every range of every asset the timeline uses | `background`, `keep: true` |
| The rest | The rest of each asset, so clips can be extended | `background`, `keep: true`, after the edit's ranges |

The editor moves the first on every `progress` event, and replaces the others on every timeline `changed` event that changes which ranges are used. An asset whose file the peer has needs no interest: it plays from its own file.

### Timeline batches and histories

| Namespace / track | Publisher | Subscribers | Content |
| --- | --- | --- | --- |
| `source` / `project` | The owner | All | The timeline's signed project record |
| `peer/<PeerId>` / `grants` | That peer | All | Its grant, and the grants of agents it carries |
| `peer/<PeerId>/batches` / `batches` | That peer | All | Timeline batches by that peer, and by agents it carries |
| `peer/<PeerId>/history/<BranchId>` / `history` | That peer, while it or an agent it carries sequences the branch | All | The branch's entries, refusals and terms |
| `peer/<PeerId>` / `presence` | That peer | All | Selection, playhead, the tool in use, a drag in progress, and the agents it carries |
| `peer/<PeerId>` / `control` | That peer | Peers following it | Its playhead, as a [control record](#control-record) |
| `asset/<PeerId>` / `<AssetId>/…` | That peer, a source of the asset | Peers that ask | The asset's catalog, chunk index, codec setups and chunks |

- **Batches and histories are broadcasts of their own,** beside `peer/<PeerId>`, because the relay authorizes broadcasts, not tracks: so it can refuse them to a peer with `view` alone.
- **Sync never reads timeline content.** For every timeline object it receives, it calls the consumer's `verify(bytes)`, which `@snowy-media/timeline` provides. It returns a batch's `{ author, seq }`, a history object's `{ branch, term, n, hash }`, or invalid. Sync orders, detects gaps and repairs by those fields alone. An invalid object, live or repaired, is dropped and not passed on; a repaired one counts as `gone`, and the next candidate is asked. Which sequencer to accept, and whether an author's rights allow a batch, are the consumer's to decide.
- **Batches** are sent like chat: queued while the stream is busy, and sent as one object when it frees up, keyed `batches/<author>/<firstSeq>-<lastSeq>`. Every batch carries its author's signature, so no checkpoint is needed.
- **History objects** are keyed by term: `history/<branch>/<term>/<firstN>-<lastN>`. A sequencer publishes on its own track, so two sequencers never write one object, even two that start the same term.
- **Refusals** go on the sequencer's history track with its entries, so every peer drops a refused batch, not only its author.
- **Repair** works as for chat ([Gaps and repair](#gaps-and-repair)), with two version vectors, exchanged once on reconnect: `{ author: seq }` for batches, and `{ branch: { term, n, hash } }` for histories. A peer that holds the named entry replies with every history object after it. One that doesn't, because one of the two is on a dropped tail, replies with its terms since that term and every entry after each term's `after`, which is enough for the consumer to drop the dropped tail.
- **The consumer stores timeline objects.** Sync opens every object it receives and hands it to the consumer as plaintext, which the consumer writes to the project folder; sync never writes it itself. To answer a repair, sync reads the plaintext through a store the consumer passes and seals the reply with its own key, as it does for chat.

### Agents a tab carries

An agent connected in a tab has its own peer key and grant, but no relay connection: the tab that connected it, named in its grant's `by`, is its **carrier**.

- The carrier publishes the agent's batches on its own `peer/<PeerId>/batches` broadcast, its grant on `grants`, and, while the agent sequences a proposal branch, that branch's history on its own `peer/<PeerId>/history/<BranchId>` broadcast, signed by the agent's key.
- **The agent is online while its carrier is,** and the carrier's presence lists it. When the carrier's namespace is announced or withdrawn, the consumer hears of the agent too.
- **Messages to the agent** go to the carrier's inbox, naming the agent.
- **Repair candidates** for the agent's objects are the same as for its carrier's own.
- An agent that runs headless connects itself, with the same grant, and is a peer like any other.

### Presence

- Presence is the newest state only: a subscriber keeps the latest object, and **nothing stores presence**, sync's store included.
- A peer publishes presence when it changes and the stream will accept more. Many changes while the stream is busy, such as a drag, become one object, so presence follows network speed, not a clock.
- **A newcomer gets everyone's presence** because each peer publishes its presence and control once more when it sees a new peer's namespace announced.
- A drag in progress is shown to others as a preview, which disappears when the batch it becomes arrives, or when the drag is cancelled.

### Following a playhead

- Nobody controls anyone else's playback in an edit session. A peer publishes its playhead as control records on `peer/<self>/control` when it plays, pauses or seeks, signed by its own peer key and naming the sequence it plays (`sequence`), with `mediaUs` the time on that sequence.
- Following someone means subscribing to their `control` and applying it as in [Playback control](#playback-control). The follower first measures its clock offset to that peer, with the same exchanges as to a watch session's source. Drift correction and command lead time are the same.
- A follower that seeks or plays on its own stops following.

### Getting current state

- **On join,** besides what a watch session's joiner asks for, a peer asks one online peer for every signed record it holds: `source/project`, every peer's grants, and every asset's catalog and codec setups from each source. Every record is signed, so it can come from any peer. Then it exchanges both version vectors.
- **After a relay restart,** every peer republishes its grants, presence and control, and every source its asset catalogs; the owner republishes `source/project`.

### Encryption in an edit session

One content key would last the project's whole life, across every presence update, batch and repair, so in an edit session each peer seals with its own: `HKDF-SHA256(sessionSecret, salt = SessionId, info = "snowy content v1 " + PeerId)`.

- **An object is sealed with the key of the peer that seals it,** which the track it arrives on names (on `source/*`, the session's key, below), never with its author's key. The AES-GCM limit of 2³² encryptions with random nonces is a limit on whoever draws the nonces, so each peer spends only its own key's budget. It stays below the limit unless one peer seals more than 4 billion objects in a project.
- **In an edit session, a peer seals everything it sends,** and never forwards bytes another peer sealed. The peer that sent an object is therefore the one whose key opens it, and the receiver always knows which peer that is:

  | Object | Sealed by |
  | --- | --- |
  | On a track under `peer/<P>` or `asset/<P>`, including everything P publishes for the agents it carries | P |
  | On `source/*` | The owner, under the key derived with `SessionId` in place of a `PeerId` |
  | On `inbox/<recipient>/<sender>/ctl` | The sender |
  | On `inbox/<requester>/<responder>/deliver`: repair replies, state on join and chunks sent on request | The responder |
  | A chunk read back from the store | The source its path names |

- **The receiver picks the key from the track an object arrived on,** never from a field inside it. The author, signer and checkpoint are inside the ciphertext, so they can't be read before the key is chosen; a carried agent's batch names the agent but arrives sealed by its carrier.
- **`source/*` names no peer, so it has a key of its own.** Only the owner publishes there, with a token the project key signs ([Authorization](#authorization)), and it seals one record per change of the project, far below the limit.

- **A key proves nothing about who sealed an object.** Everyone with the secret derives every peer's key, so any member can seal under any key. Authenticity comes only from signatures and checkpoints, as for chat ([Sending](#sending)).

### Sequencer changes

`@snowy-media/timeline` chooses its sequencer from who is online. Sync reports every `announce` and `unannounce`, and the agents each carrier's presence lists, to the consumer for this, so the choice needs no timer.

## Events

Every action in the system responds to one of these events:

| Event | Source | Reaction |
| --- | --- | --- |
| `announce(peer)` / `unannounce(peer)` | Relay | Update presence. Plan or drop links. Place the requests that waited on the source. In an edit session, tell the consumer, which may change sequencer. |
| `link open` / `link close` | WebTransport, WebRTC | Start or stop requesting through the link. Retry its requests elsewhere. |
| `writable` | Writer `ready`, `bufferedamountlow` | Send the next queued object or batch |
| `delivery done` | Link | Mark the request done. Update measured upload, RTT and throughput. |
| `stored(key)` / `evicted(key)` | Store | Batch a `have` update. Resume playback after waiting. Tell the consumer. |
| `storage-full` | Store | Stop fetching. Tell the consumer, which narrows, releases or drops. |
| `file-changed` | Source, re-cutting a chunk | Reply `gone`. Tell the consumer. |
| `interest` / `move` / `release` | Consumer | Replan requests. Evict chunks no interest covers. Update `caps.wants`. |
| `progress(t)` | Engine media clock | The consumer moves its interests. Check the deadlines of urgent requests. Drift correction. |
| `started` / `paused` | Engine | Confirm a scheduled command |
| `control(record)` | `source/control` | Schedule play, pause or seek at `atUs` with the engine |
| `catalog(version)` | `source/catalog` | Update the tracks and bitrates shown |
| `caps(record)` | `peer/*/caps`, the source's inbox | Candidate forwarders, audio tracks to push, slot counts |
| `have(ranges)` | `peer/*/have`, `ctl` | Plan chunk requests |
| `request` / `cancel` / `busy` / `gone` | `inbox`, `ctl` | Serve, stop, or try the next source |
| `chat(batch)` | `peer/*/chat` | Store, sort, detect gaps |
| `batches(object)` | `peer/*/batches` | Verify, hand to the consumer, detect gaps |
| `history(object)` | `peer/*/history/*` | Verify, hand to the consumer, detect gaps |
| `presence(state)` | `peer/*/presence` | Hand to the consumer. Never store. |
| `project(record)` | `source/project` | Hand to the consumer: the sequencer list |
| `grants(record)` | `peer/*/grants` | Check the chain. Hand to the consumer. |
| `commit(batch)` / `sequenced(objects)` | Consumer | Queue on `batches` or `history/<branch>`, sent when the stream is writable |
| `probe received` | `peer/<self>/probe` | Set measured upload. Re-check whether to forward. |
| `visibilitychange` | Document | Re-check whether to forward |
| `setting change` | User | Re-check whether to forward, probing first if sharing was turned on. Audio choice. Subtitle choice. |
| `ice failed` | WebRTC | Mark the pair relay-only |

The transports' keepalives and idle timeouts (QUIC's idle timeout, WebRTC's connection-freshness checks) and the engine's media clock are the only clocks in the system. They arrive as `link close`, `progress`, `started` and `paused` events.

## The relay

### Behaviour

- Forwards every object to its current subscribers and to whoever it was addressed to, then forgets it.
- Keeps no cache, no history and no latest value. It has no timers of its own beyond QUIC's.
- **After a restart:** every peer gets `link close`, reconnects, re-announces and republishes its current capability record and `have`. The source republishes `catalog`, `control` and the page of the index still filling. No data is lost, because peers hold all of it.

### Authorization

| Who | May publish | May subscribe |
| --- | --- | --- |
| Source `S` (token signed by the session key and `S`'s peer key) | `source`, plus everything peer `S` may publish | Everything |
| Peer `P` (join grant plus a request signed by `P`) | `peer/P`, `inbox/*/P` | `source`, `peer/*`, `inbox/P/*` |
| Edit session: owner `O` (token signed by the project key and `O`'s peer key) | `source`, plus everything peer `O` may publish with every right | Everything |
| Edit session: peer `P` with `view` (its grant plus a request signed by `P`) | `peer/P`, `inbox/*/P` | `source`, `asset/*`, `peer/**`, `inbox/P/*` |
| Edit session: peer `P` with `propose` | The same, plus `peer/P/batches` and `peer/P/history/*` | The same |
| Edit session: peer `P` with `edit` | The same as with `propose`, plus `asset/P` | The same |

- **Patterns are moq-relay's:** a path without a wildcard is that broadcast alone, so `peer/P` doesn't cover `peer/P/batches`; `*` is one segment, and `**` any number. The relay tests check that a peer with `view` alone can't publish batches, histories, assets or `source`. They also check that one with `propose` can't publish assets, and one with `edit` can.
- **The relay authorizes broadcasts**, the paths in the table, and every track in a broadcast with it, so a peer may subscribe to any track of another peer's broadcast, `have` and `probe` included. Neither is secret.
- **moq-relay asks an auth server** about each connection (`--auth-url`), posting the path and query it was dialed with; the server answers with the patterns the table gives, or refuses. The server is `authServer` in `src/relay-auth.ts`, or one `createAuthServer` makes with the app's [admission](#admission): a `fetch` handler on Web Crypto that keeps nothing between requests, run beside the relay (`Bun.serve({ fetch: authServer })`, on a loopback address, since moq-relay asks a plain `http://` server only there).
- **A new connection's token must be fresh**: made at most 5 minutes before, or 1 minute after, by the server's clock. A connection already admitted keeps its grant, however old its token, until it closes or the app's `admit` refuses it.
- **moq-relay admits a connection only after making it**, so a refused token doesn't fail the connect. The relay ends the connection, and the connection's `close` says it was refused.

### Admission

The auth server decides what keys allow. Whether to admit someone the keys allow, such as a limit on how many may join, is the app's policy, and the package knows nothing of it. An app that has one passes it to `createAuthServer`.

```ts
type Connection = {
  id: string;
  session: SessionId;
  peer: PeerId;
  role: "source" | "peer" | "owner" | "editor";
  rights: Array<"view" | "propose" | "edit">;
  grant?: Grant;              // an editor's: who gave it its rights
};

type Ended = { id: string; reason?: string; bytes?: { toPeer: number; fromPeer: number } };

type Admission = {
  admit?: (connection: Connection) => boolean | Promise<boolean>;
  end?: (ended: Ended) => void | Promise<void>;
};
```

- **`admit` is asked after the token checks out,** on every `connect` and `revalidate`; a token that fails is refused without asking. `id` is the relay's own id for the connection, which every request about it carries, `role` is the token's kind, and `rights` what it carries: a grant's rights in an edit session, every right for the owner, and `view` alone in a watch session. An app that limits who may edit decides by `rights`: `propose` and `edit` are the ones that change the project. `false` refuses with 403, as a failed token does.
- **An editor's `grant` says who gave it its rights,** so an app can count a person's agents as that person. An agent that connects itself is asked as itself, and its grant's `by` names the person who passed it on. A grant from the project key names only the peer; an invite's names no one, and an app that needs to know who holds it asks in its own way.
- **A refusal on `revalidate` ends an admitted connection.** moq-relay asks again when the grant's cadence or a push to its internal listener (`/sessions/revalidate?id=…`) says so, so an app removes someone by refusing them and pushing. This server sets no cadence, so without a push an admitted connection is never asked again.
- **`end` is told the id of every admitted connection the relay closes,** including one a revalidation refused; a connection refused on `connect` has no `end`. The id is what a connection's `connect`, `revalidate` and `end` share, and `end`'s token isn't checked again, so an app that counts connections keys them by id. The id is the relay's word only while the relay alone can reach the auth server, as on the loopback address above; anyone else who can post to it can report an end.
- **A failure answers 500.** moq-relay refuses a new connection on any answer but a grant or a refusal, retries a revalidation with backoff, and only logs a failed `end`, so an app whose policy is down admits no one new and removes no one.
- **`end` carries why the connection ended and what it moved through the relay,** as moq-relay reports it. `reason` is the relay's: the connection's own close reason, or `refused`, `expired`, `invalid` or `dropped` when the relay closed it. `toPeer` is what the relay sent the peer, and `fromPeer` what it received, over the connection's whole life. With the session `admit` saw for the same id, that is what an app meters relay traffic by, per session or per person.
- **`bytes` is absent unless the relay counted them.** moq-relay counts bytes only over QUIC, WebTransport included, and reports zeros for its other transports, which a peer may dial whatever Snowy's clients use. It also reports zeros for a connection it closed itself as `refused`, `expired`, `invalid` or `dropped`. An app that meters by `end` has no count for those connections. The reason and counts are the relay's word on the same terms as the id.
- **An `end` can be missed.** The grant sets no cadence or expiry, so if the relay stops, or gives up on a `connect` that `admit` already allowed, no `end` comes and nothing asks again. An app that counts connections expires them itself.
- **Without `admit`, every connection whose token checks out is admitted.** `authServer` is `createAuthServer()`.
- **The package keeps nothing for the policy.** Counting connections, mapping peer keys to people (a person has a peer key per device) and limiting them are the app's, in its own server. An agent a tab carries never reaches `admit`, since it rides that peer's connection; a headless agent connects as a peer and is asked like one.

## Security

| Threat | Protection |
| --- | --- |
| The relay or an outsider reading content | All objects are encrypted with AES-GCM under a key derived from the session secret, which lives only in the URL fragment. Every encryption uses a fresh random nonce. |
| A peer forging media | Chunk headers are signed by the session key, and the body hash is checked before storing |
| A peer forging capability records | Records are signed by the peer key |
| A peer forging chat while repairing gaps | Author hash chains plus signed checkpoints |
| A peer posting as someone else | Relay authorization: only `P` can publish `peer/P` |
| A relay token read from a log or by the relay | Replayed, it admits a connection only within 5 minutes of being made, as the peer that signed it, in its own session. The join grant inside it never expires, so whoever reads one can join with keys of their own for the session's life, as with a leaked invite but without the session secret: they see track names and sizes, and can write to peers' inboxes, but can't read or forge content. A request names its session and the server checks it against the path dialed, so the token admits no one in another session, whatever grant comes with it. A connection once admitted is never revoked. |
| An edit-session token read from a log or by the relay | Replayed, it admits a connection only within 5 minutes of being made, as the peer that signed it, in its own session. A grant naming a key in `to` admits only that key, unless its `chain` is an invite: the token then carries the invite, which anyone can reuse. A grant that is an invite admits anyone with keys of their own, at its rights, for the project's life; without the session secret they can't read content or get an edit accepted. An owner token carries no grant to reuse. |
| A viewer controlling playback | Only the source can publish `source`, and control records are signed |
| Script injection through chat | `textContent` only |
| A peer forging an edit or another's asset | Timeline batches are signed by their author and checked against the author's grant; asset chunk headers are signed by the source named in the namespace |
| A peer forging history | Entries are signed by the sequencer; the consumer accepts them only from the sequencer the signed project record and the latest term name |
| A leaked edit invite | Nothing: grants never expire and the session secret lasts the project's life, so whoever holds a leaked invite can read and edit for good. The only remedy is a new project. |
| An agent exceeding its person's rights | A grant can only pass on rights the granting key holds, and peers check the chain |
| Keys being read out of the store | Private keys are non-extractable `CryptoKey`s |
| Content left on devices | With `onEnd: "delete"`, the session's store is deleted on [leave or end](#session-lifecycle), and on the next app start after a crash. With `onEnd: "keep"`, the consumer owns it. |

## Session lifecycle

| Step | What happens |
| --- | --- |
| **Create** | The source picks a file, keeps its handle, generates the session key, its peer key and the secret, signs a join grant, fingerprints the file, demuxes enough to write `catalog` and `init/*`, connects to the relay, and shows the invite link. |
| **Join** | A peer opens the link, generates its peer key, connects with grant plus signed request, announces itself, gets state from the source or a peer, asks the user about Share my upload, assesses itself, publishes its capability record, measures its clock offset, joins groups, and its consumer places its interests at the playhead. |
| **Watch** | Driven entirely by the [events](#events) above |
| **Source drops** | Peers play from their stores and pause locally on a missing chunk. Chat carries on. |
| **Source resumes** | The source reopens its handle, asking permission again with a click if it was dropped, checks the fingerprint, reconnects and publishes a new control record. |
| **Relay drops** | Playback continues from local stores. Chat queues locally. Everything resumes on reconnect. |
| **Leave** | The peer closes its links. Its namespace is withdrawn. With `onEnd: "delete"`, its session store (OPFS directory and IndexedDB entries) is deleted. |
| **End** | The source publishes control with `ended: true`. Every peer stops playback, closes its links and applies its `onEnd`. |
| **App start** | Every session store with `onEnd: "delete"` is deleted, except the one whose invite link is being opened, which carries on where it left off. |

An edit session differs in these steps:

| Step | What happens |
| --- | --- |
| **Create** | The owner opens a project, whose project key becomes the session key, gives its own peer key a grant with every right, signs an invite, connects, publishes `source/project` and its grants, and publishes a catalog for each asset whose file it has. |
| **Join** | As for a watch session, without the upload question and forwarding. The peer then gets current state ([Getting current state](#getting-current-state)), exchanges version vectors, and publishes its grants and a catalog for each asset whose file it has. Its interests come from the render plan. |
| **Edit** | Driven by the [events](#events), with the timeline's commits and sequenced entries among them |
| **A source leaves** | Its assets play from chunks peers hold. Editing goes on. |
| **The sequencer leaves** | `@snowy-media/timeline` chooses the next one from the `unannounce` event; until then, batches stay pending. |
| **Leave** | As for a watch session. Edit sessions use `onEnd: "keep"`, so chunks of other people's assets stay for the next session. |

## Requirements on @snowy-media/engine

The sync package needs these engine capabilities through public exports:

| Capability | Used for |
| --- | --- |
| **A pluggable packet source**: play from codec setup plus packet records supplied by the caller, not a `File` | Playing chunks from the store |
| **Demuxer access at the source**: read packets and track info from a `FileSystemFileHandle`, and seek to a time | Cutting chunks, and cutting past chunks again |
| **Choosing the audio track**, including while playing | Per-viewer audio |
| **Subtitle rendering**: text (SRT, ASS) and bitmap (PGS), with the track chosen while playing | Per-viewer subtitles |
| **Scheduled play, pause and seek** at a given wall-clock time, carried out by the media clock, with `started` and `paused` events | Commands that every peer applies at the same moment |
| **Playback rate** within ±5%, with the audio resampled | Drift correction |
| **`progress` events** from the media clock | The scheduler, drift correction |
| **Frame-exact `seek`** | Seeks and large drift |
| **Discarding frames before a start time** when decoding begins at a chunk | Open-GOP chunks |

## Constants

| Constant | Value |
| --- | --- |
| Minimum video chunk length | 2 s, closed at the next keyframe |
| Chunk index page | 64 chunks |
| Requests out per link | 2, or more while their bytes are under throughput × RTT |
| Requests the source holds per peer | 4 |
| Urgent window | Playhead to playhead + 30 s |
| Player interest | 2 min behind to 15 min ahead of the playhead |
| Push horizon | 15 min ahead of the playhead |
| File fingerprint | Size, `lastModified`, SHA-256 of the first and last MiB |
| Command lead time (`atUs` ahead of now) | 500 ms |
| Drift: ignore / adjust rate / seek | < 40 ms / 40–500 ms / > 500 ms |
| Maximum rate adjustment | ±5% |
| Clock-sync exchanges | 5, sent one after another |
| Upload probe | 1 s of session bitrate, at most 2 MB |
| Share of upload offered as slots | 60% |
| Forwarder: start / stop | Upload ≥ 1.67× / < 1× the session bitrate |
| Forwarders tried / kept per receiver | 8 / 4 |
| Data channel message size | At most 64 KiB, header included |
| Data channel buffer: pause / resume | 1 MiB / 256 KiB |
| AES-GCM nonce | 96 random bits per encryption |
| HLC layout | 16 hex digits: 48-bit wall ms, then 16-bit counter |
| Received HLC ignored when ahead of the wall clock by | More than 60 s |
| Relay token: admits for / may be ahead of the auth server's clock by | 5 min / 1 min |

## Limits

- **Networks that block UDP** can't join. WebTransport and WebRTC both need UDP, and there is no TURN.
- **No transcoding.** Every peer must be able to decode the catalog's codecs. When a peer joins, it checks each track with `VideoDecoder.isConfigSupported` / `AudioDecoder.isConfigSupported` and refuses to join with an error naming the codec.
- **One source per session.** If a watch session's source leaves for good, the session can't continue beyond what peers already hold. In an edit session the same holds for an asset once no editor with its file remains.
- **Edit sessions fetch media through the relay only.** Forwarders and peer groups serve watch sessions; in an edit session every chunk comes from its source through the relay, once per peer that asks.
- **Grants in an edit session don't expire and can't be revoked,** and the session secret lasts the project's life. A leaked edit invite gives lasting access; the only remedy is a new project.
- **The source's file must stay unchanged.** If it is edited, moved or deleted, the source can't resume.
- **The relay is on the live path.** While it's down, playback continues from local stores but nothing new arrives.
- **Peer upload is opt-in.** Sessions where nobody forwards are served entirely through the relay.
- **Join grants don't expire and can't be revoked.** Anyone holding the invite link can join for as long as the session runs.
- **Chunk length follows the file.** A file with long keyframe intervals makes long, large video chunks.

## Testing

- **Unit tests** (`test/*.unit.ts`, `bun run test`) run in Chromium, each file in a module worker of its own page (`tooling/run-unit.ts`), as every package's tests do: never in Bun, so Web Crypto, `DataView` and base64 are tested in the browser that ships them. The worker is a dedicated one, so the chat store's OPFS sync access handles are tested there too, each test in a session directory of its own. Peers in a test are joined by links in memory (`test/support/memory-link.ts`), which carry messages as JSON, as a transport does. They run in CI's `sync test` job on every change to the package.
- **Browser tests** (`test/*.test.ts` other than `unit.test.ts`) drive a page with Playwright, as the engine's do, for the modules that need one: IndexedDB, File System Access, WebTransport, WebRTC, and the engine itself.
- **The relay tests** (`test/relay.test.ts`) run peers in workers of Chromium pages against a real relay: moq-dev's moq-relay, pinned by digest and started in Docker for each test (`test/support/relay.ts`), so one that fails can't fail the next. Its auth server is `src/relay-auth.ts`'s, served by Bun in a container on the relay's network (`test/support/auth-server.ts`); the unit tests check the same code in Chromium. Its certificate is made for each run and trusted by its hash, so none is kept. On Colima, which doesn't forward UDP ports, the relay is reached at the VM's address: start Colima with `colima start --network-address`.
- **The test relay keeps objects** for a while after forwarding them, which the design's relay doesn't. No test relies on it.

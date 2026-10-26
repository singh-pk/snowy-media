# Architecture

How @snowy-media/timeline is built: the document a Snowy edit is, the operations that change it, and the one linear history every person and agent editing a project shares. For using it, start with the [README](../README.md).

## Contents

1. [Principles](#principles)
2. [Package boundaries](#package-boundaries)
3. [Time](#time)
4. [Projects, assets and files](#projects-assets-and-files)
5. [The document](#the-document)
6. [Layout](#layout)
7. [Operations](#operations)
8. [Linear history](#linear-history)
9. [Undo, revert and going back](#undo-revert-and-going-back)
10. [Branches](#branches)
11. [Agents](#agents)
12. [Identity and rights](#identity-and-rights)
13. [The project folder](#the-project-folder)
14. [Queries and the render plan](#queries-and-the-render-plan)
15. [Calls and events](#calls-and-events)
16. [Requirements on @snowy-media/sync](#requirements-on-snowy-mediasync)
17. [Requirements on @snowy-media/engine](#requirements-on-snowy-mediaengine)
18. [Constants](#constants)
19. [Limits](#limits)

## Principles

| Principle | Meaning |
| --- | --- |
| **One linear history** | Every edit by every person and agent is an entry in one ordered history per branch, the same for everyone. The document is that history applied in order. |
| **Edits are operations** | The interface, an agent and a remote peer change the document the same way: by committing a batch of typed operations. Nothing else changes it. |
| **Positions are derived** | A storyline clip's time is the sum of the durations before it, and a connected clip's time follows the clip it is anchored to. No edit has to move anything else, so edits made at the same time never collide. |
| **One writer per object** | Each author writes only their own log of batches, and each sequencer writes only its own history track. Two peers never write the same object, as in `@snowy-media/sync`. |
| **Nothing is lost** | Logs and histories are append-only, with one exception: entries a vanished sequencer appended that its successor never received are replaced ([Changing sequencer](#changing-sequencer)), and their batches are appended again. A removed item keeps its state, so it can be restored with everything done to it. Undo and revert are new entries, never rewrites. |
| **Non-destructive** | The timeline refers to media; it never changes a user's media file. |
| **Event-driven** | No timers and no polling. Everything happens on a call from the caller ([Calls and events](#calls-and-events)). |
| **Pure** | No DOM, no network, no storage and no media. The package takes bytes and calls and returns state and events, so an agent can use it without a browser; its tests run in Chromium, as every package's do. |

## Package boundaries

- `@snowy-media/timeline` is its own package, under the Snowy License ([LICENSE.md](../../../LICENSE.md)), with no dependency on another Snowy package. Where it must match `@snowy-media/sync` byte for byte (the hybrid logical clock), it has its own implementation of the same format.
- **It knows nothing about media.** An asset is an identity and the stream facts the editor read when it was added. Reading, decoding and drawing are `@snowy-media/engine`'s; the timeline hands it a [render plan](#queries-and-the-render-plan).
- **It knows nothing about networks.** It produces signed batches, history entries, refusals and terms as bytes and takes the ones others produced. Carrying them between peers is `@snowy-media/sync`'s ([Requirements on @snowy-media/sync](#requirements-on-snowy-mediasync)).
- **It knows nothing about storage.** It says what to write and reads what it is given; the editor writes the [project folder](#the-project-folder).
- **The editor app** owns the interface, file handles, the project folder, and the tool registry agents call ([Agents](#agents)).

## Time

All times on a timeline are integers in **flicks**: 705,600,000 per second.

- One frame at every common rate is a whole number of flicks (23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 119.88 and 120 fps), and so is one sample at every common audio rate (44.1, 48, 88.2, 96 kHz). Sums of durations are exact; nothing drifts.
- A JavaScript number holds flicks exactly up to about 147 days.
- A sequence's rate is a fraction `[num, den]` whose frame is a whole number of flicks; others are refused.
- **Source points are in the stream's own units.** A clip's in-point is a timestamp in its stream's time base, the integer FFmpeg reports, so a clip starts on exactly the frame chosen, whatever the time base. Many time bases aren't whole flicks (1/15360 s is 45,937.5 flicks), so source points are converted to flicks only to lay a clip out, never stored as flicks.
- **Rounding:** every conversion to flicks is computed exactly, as a fraction of integers, then rounded once to the nearest flick, halves upwards. Every peer therefore gets the same integer.
- **Video sits on frames.** Storyline durations are whole frames of the sequence. A connected video item's computed time is snapped down to the frame boundary at or before it. Audio items keep their time to the flick, which is finer than a sample.
- The engine works in microseconds; the [render plan](#queries-and-the-render-plan) converts at that boundary, and nothing converts back.

## Projects, assets and files

### Project

A project is one edit: its sequences, assets and history.

```ts
type Project = {
  id: ProjectId;              // base64url public key of the project key
  name: string;
  sequencers: KeyId[];        // who may sequence main, in priority order (Linear history)
  sig: string;                // Ed25519 by the project key over the fields above
};
```

### Assets

An asset is a media file the project uses, known by what it contains, not by a path or a handle:

```ts
type Asset = {
  id: AssetId;                // SHA-256 of size and the two hashes below, unpadded base64url
  size: number;
  head: string;               // SHA-256 of the first MiB
  tail: string;               // SHA-256 of the last MiB
  name: string;               // the file name when added
  streams: Array<{
    index: number;
    kind: "video" | "audio" | "subtitle";
    timeBase: [number, number];
    start: number;            // in the time base
    duration: number;         // in the time base
    rate?: [number, number];  // video: average frame rate
    width?: number;
    height?: number;
    sampleRate?: number;
    channels?: number;
  }>;
  path?: string;              // relative to the project folder, when it is inside it
};
```

- **Identity is size and content,** not `lastModified`, which differs on every copy of a file. Two people adding the same footage get one asset, and a collaborator with a copy of the file can link it.
- **Handles stay on each device.** `FileSystemFileHandle`s can't be shared, so each device keeps its own map from asset to handle in IndexedDB, with the file's `lastModified` when it was last checked. A collaborator who doesn't have a file still has the asset; its media reaches them through `@snowy-media/sync`.
- **A changed file:** when a handle's file has a different `lastModified`, the editor checks its size and hashes again. If they differ, the file isn't the asset any more, and the asset shows offline on that device.
- **Relinking** points an asset at a file with the same size and hashes, or at a folder, which is searched by name and size first, then by hashes. Relinking is local to a device, not an operation.
- **Media is never written.** Everything the editor derives from a file (keyframe index, waveforms, thumbnails, analysis) goes to the project folder, keyed by asset.

## The document

A project holds one or more sequences. A sequence is a storyline, the items connected to it, and its roles.

```ts
type Sequence = {
  id: ItemId;
  name: string;
  rate: [number, number];     // frames per second, as a fraction
  width: number;
  height: number;
  sampleRate: number;
};
```

Its roles are records of their own, each naming the sequence it belongs to ([Roles](#roles)), so adding a role never rewrites the sequence.

### Ids

An item made by an operation has the id `<author>.<seq>.<index>`: its batch's author, the batch's seq, and the operation's place in the batch. Author keys are unpadded base64url, which has no `.`, so an id is safe in a file name or a track name. Ids are unique without a counter or a coordinator. Sequences, roles, effects and branches get their ids the same way, so `RoleId` and `BranchId` (other than `main`) are item ids too.

### Items

Every item has an `id` and `kind`, and one anchor that places it.

| Kind | What it is |
| --- | --- |
| `clip` | A range of one stream of an asset, of a generator (text, solid colour, shapes), or of another sequence (a compound clip) |
| `gap` | Empty storyline time |
| `transition` | A transition at a storyline edit point |
| `marker` | A named point or range: a marker, a chapter or a to-do |

```ts
type Clip = {
  id: ItemId;
  kind: "clip";
  source:
    | { asset: AssetId; stream: number }
    | { generator: string; params: Record<string, Value> }
    | { sequence: ItemId };
  in: number;                 // source point: stream time-base units, or flicks for a generator or sequence
  duration: number;           // flicks on the timeline
  speed: [number, number];    // a fraction; negative plays in reverse
  anchor: Anchor;
  role: RoleId;
  lane: number;               // the lane it prefers among its role's lanes (Layout)
  enabled: boolean;
  name?: string;
  video?: { opacity: number; blend: Blend; transform: Transform };
  audio?: { gainDb: number; pan: number; fadeIn: number; fadeOut: number };  // fades in flicks
};

type Gap = { id: ItemId; kind: "gap"; anchor: Anchor; duration: number };

type Marker = {
  id: ItemId;
  kind: "marker";
  anchor: Anchor;
  duration: number;           // 0 for a point
  type: "marker" | "chapter" | "todo";
  name: string;
  note?: string;
  done?: boolean;             // a to-do's
};

type Value = boolean | number | string | Value[];   // numbers finite; -0 is 0
type Blend = "normal" | "add" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "difference";
type Transform = { x: number; y: number; scaleX: number; scaleY: number; rotation: number };
```

Fields are addressed by path, down to a leaf: `in`, `video.opacity`, `video.transform.x`, `audio.gainDb`. Two people changing two leaves of one object both keep their change.

### Anchors

An anchor says where an item is. There are three kinds:

```ts
type Anchor =
  | { storyline: ItemId; position: string }    // in a sequence's storyline, at a fractional position key
  | { clip: ItemId; at: number }               // connected to a storyline clip, at a source point of it
  | { origin: ItemId; at: number };            // connected to a sequence's start, at a time in flicks
```

| Anchor | Moves when | Use |
| --- | --- | --- |
| **Storyline** | Anything before it in the storyline changes length | The main edit |
| **Clip** | Its clip moves | B-roll, sound effects, titles that belong with what happens in the clip |
| **Origin** | Never by itself | Music to a cue, a logo at an exact timecode: anything placed "exactly here" |

- **Storyline order is by position key,** a fractional index: a string that sorts between its neighbours' keys, so an item can always be put between two others without changing them. Items are ordered by `(position, id)`. Moving an item sets its key and moves nothing else, and a key can't point anywhere, so order can't form a cycle. Several items inserted together get consecutive keys and stay together.
- A clip anchor names a **source point** of its clip, not an offset from the clip's start, so a connected clip stays on the same moment of the clip's media when the clip is trimmed at its head or changes speed. The point may lie outside the clip's range; the connected clip then sits before or after it. At a negative speed, `in` is still the source point at the clip's start, and playback runs down from it.
- **Only storyline clips take connected items,** and a connected item can't anchor to another connected item. Applying enforces both (see [Applying](#applying)), so a chain of connected items never forms, even from edits made at the same time.
- A connected item whose clip is removed keeps its anchor. It sits where the removed clip was, at the same source point, and is marked *orphaned* until it is moved or the clip is restored.
- The interface picks the anchor from how a clip is placed. With magnetism on, a clip dropped over the storyline connects to the clip under it; with it off, it connects to the origin.

### Roles

```ts
type Role = {
  id: RoleId;
  sequence: ItemId;
  name: string;               // Dialogue, Music, Effects, Titles, B-roll…
  kind: "video" | "audio";
  color: string;              // "#rrggbb", lowercase
  order: string;              // fractional index: the role's place among its kind
};
```

A role groups connected items: the interface shows each role's lanes like tracks (V1, V2…, A1, A2…), mixes each audio role into its own bus, and exports stems by role. Roles are a view, not a place: moving a clip to another role moves it to that role's lanes.

### Effects and keyframes

```ts
type Effect = {
  id: ItemId;
  clip: ItemId;
  kind: string;               // from the editor's effect registry, e.g. "color.wheels", "audio.eq"
  position: string;           // fractional index: its place in the clip's chain
  enabled: boolean;
  params: Record<string, Value>;
};

type Keyframe = {
  target: ItemId;             // an effect, or a clip for its own video and audio fields
  param: string;              // a parameter, or a field path
  at: number;                 // a source point of the clip, like a clip anchor
  value: Value;
  ease: "hold" | "linear" | { bezier: [number, number, number, number] };
};
```

- A keyframe is known by its `(target, param, at)`: setting one there replaces it, so two people setting the same keyframe keep the later value, as for any leaf.
- Keyframes are at source points for the same reason connected items are: a head trim or a speed change keeps them on the same moment of the media.
- The timeline stores effect kinds and their parameters as data and checks a parameter's value only against its declared type. What an effect does is the engine's, where its shader lives.

### Transitions

A transition is anchored to an edit point, not placed in the storyline's order: `{ kind: "transition", cut: ItemId, duration, effect, params }`, where `cut` is the storyline item whose end is the cut. It counts nothing in the storyline's length. It is split in whole frames on either side of the cut, the odd frame after it, and plays from the media past each side's edit, which must be there when it is made. Each half shortens on its own to the media its side has, so a later edit that takes media away can leave it off centre; if its item is removed, it isn't shown until the item is restored.

## Layout

The document stores anchors and durations; times are worked out from them, the same way on every peer.

- **Storyline:** the items anchored to the storyline, ordered by `(position, id)`. Each item's start is the sum of the durations before it. They are kept in a balanced tree ordered by position, with each subtree's total duration, so inserting, removing, moving or changing the length of an item costs O(log n), and so does finding the item at a time.
- **Connected items:** a clip anchor's time is its clip's start plus `(at − clip.in) / speed`, converted and snapped as [Time](#time) says; an origin anchor's time is `at`.
- **Lanes:** connected items are laid out per role, ordered by start time and then by id. Each goes in the lane it prefers if that lane is free over its whole range, and otherwise in the nearest free lane above. Two clips placed in the same spot at the same time both stay: they stack. A clip stays in its preferred lane as long as the lane is free; an edit that makes clips overlap that didn't before can push one up.
- **Compositing order:** the storyline at the bottom, then video roles in `order`, then lanes from the lowest up.
- **Incremental:** applying an entry recomputes only what its operations reach, and reports the changed time range ([Calls and events](#calls-and-events)).

## Operations

### Batches

Edits are committed as batches. One batch is one gesture: a drag, a trim, a paste, an agent's whole plan. It is applied all at once, in the order of its operations, and it is one entry in the history.

```ts
type Batch = {
  author: KeyId;              // the author's peer key
  seq: number;                // 1, 2, 3, … per author per project
  prev: string;               // hash of the author's previous batch, or "" for seq 1
  branch: BranchId;
  branchPrev: number;         // seq of the author's previous batch on this branch, or 0
  base: EntryRef;             // the last entry of `branch` the author had applied
  hlc: string;                // hybrid logical clock, in @snowy-media/sync's chat format
  label: string;              // what it did, for the history: "Ripple delete", "Removed 14 silences"
  undoes?: BatchRef;          // set on an undo (Undo, revert and going back)
  ops: Op[];
  sig: string;                // Ed25519 by the author's peer key
};

type EntryRef = { n: number; hash: string };   // { n: 0, hash: "" }: before a branch's first entry
type BatchRef = { author: KeyId; seq: number };
```

- **Canonical bytes:** a batch's JSON with every object's fields in the order its type declares, the keys of open records (`params`) in code-point order, absent fields left out, no whitespace, as UTF-8. A peer re-encodes every batch it parses and refuses one whose bytes differ, or that has an unknown field, as `@snowy-media/sync` does for chat. The signature covers `snowy batch v1\n` followed by the canonical bytes without `sig`.
- **Hashes** are SHA-256 of canonical bytes, as unpadded base64url. A batch's hash covers its signature too.
- **Limits:** names and labels are at most 256 UTF-16 code units, texts and values' strings at most 65,536, lists and open records at most 4096 entries, lists in a value nested at most 8 deep, and the whole batch 1 MiB, which alone bounds how many operations it holds.
- **Pointer gestures commit on release.** While a drag goes on, its preview goes to other peers as presence, which is never stored ([Requirements on @snowy-media/sync](#requirements-on-snowy-mediasync)); the batch is made on `pointerup`. The history holds edits, not mouse moves.

### Operation kinds

| Operation | Does |
| --- | --- |
| `project.set` | Renames the project |
| `asset.add` / `asset.remove` | Adds an asset record, or marks one unused |
| `sequence.add` / `sequence.set` / `sequence.remove` | A sequence and its settings |
| `role.add` / `role.set` / `role.remove` | A role |
| `item.add` | Adds a clip, gap, transition or marker with all its fields |
| `item.set` | Sets one leaf of an item: `{ id, path, value }` |
| `item.move` | Gives an item a new anchor: a storyline position, a clip and source point, or the origin |
| `item.remove` / `item.restore` | Removes an item, keeping it as a tombstone with its state; or restores it |
| `clip.split` | Splits a clip at a timeline time into two, the second with a new id; connected items and keyframes after the split, and a transition on its end, move to the second, and its effects stay with the first |
| `clip.join` | Joins two neighbouring pieces of one source that meet exactly, as a split left them, back into the first |
| `effect.add` / `effect.set` / `effect.remove` | An effect, one of its parameters, or its place in the chain |
| `keyframe.set` / `keyframe.remove` | One keyframe |
| `revert` | Sets the whole document back to an earlier entry ([Undo, revert and going back](#undo-revert-and-going-back)) |
| `branch.create` / `branch.merge` / `branch.close` | [Branches](#branches) |

An operation that adds a record carries it without its `id`, which is the operation's own ([Ids](#ids)); an asset, whose id is its content's, is the one exception. Each is a record with `op` first:

```ts
type Op =
  | { op: "project.set"; name: string }
  | { op: "asset.add"; asset: Asset }
  | { op: "asset.remove"; id: AssetId }
  | { op: "sequence.add"; sequence: Omit<Sequence, "id"> }
  | { op: "role.add"; role: Omit<Role, "id"> }
  | { op: "item.add"; item: Omit<Clip | Gap | Transition | Marker, "id"> }
  | { op: "item.move"; id: ItemId; anchor: Anchor }
  | { op: "clip.split"; id: ItemId; at: number }              // a timeline time, in flicks
  | { op: "clip.join"; id: ItemId; next: ItemId }
  | { op: "effect.add"; effect: Omit<Effect, "id"> }
  | { op: "keyframe.set"; keyframe: Keyframe }
  | { op: "keyframe.remove"; target: ItemId; param: string; at: number }
  | { op: "sequence.set" | "role.set" | "item.set" | "effect.set"; id: ItemId; path: string; value: Value }
  | { op: "sequence.remove" | "role.remove" | "item.remove" | "item.restore" | "effect.remove"; id: ItemId }
  | { op: "revert"; to: EntryRef }
  | { op: "branch.create"; name: string }                    // the branch's id is this operation's
  | { op: "branch.merge"; branch: BranchId; through: EntryRef }
  | { op: "branch.merge"; branch: BranchId; entries: EntryRef[] }
  | { op: "branch.close"; branch: BranchId };
```

`BranchId` is `"main"` or the id of a `branch.create` operation. A path names a leaf in lower camel case, such as `video.transform.x`; which paths a record has, and the type of each, is checked when the operation is applied.

Every editing tool is a batch of these:

| Tool | Operations |
| --- | --- |
| Insert | `item.add` with a storyline position |
| Move in the storyline | `item.move` to a new position: what it leaves closes up, and what follows where it lands moves along |
| Connect, or move a connected item | `item.add` or `item.move` with a clip or origin anchor |
| Ripple delete | `item.remove`: what follows closes up by itself |
| Lift | `item.remove`, and `item.add` of a gap as long as it, at its position |
| Ripple trim | `item.set` of `in` and `duration`, or of `duration` alone |
| Roll | `item.set` of the left clip's `duration`, and the right clip's `in` and `duration`, so the cut moves and nothing else does |
| Slip | `item.set` of `in` |
| Slide | `item.set` of the previous neighbour's `duration`, and the next neighbour's `in` and `duration` |
| Blade | `clip.split`, and `effect.add` and `keyframe.set` copying the clip's effects and their keyframes onto the second piece |
| Overwrite | `clip.split` at both ends of the range, `item.remove` of what lies between, `item.add` of the new clip at its position |

### Applying

- Operations are checked when a batch is made, and the author is told what is wrong.
- **Applying checks every operation again** and skips any that doesn't fit, so a buggy or hostile batch can't break anyone's document:
  - malformed: a value of the wrong type or out of range, an unknown path;
  - stale: setting a field of an item that doesn't exist, splitting a clip at a time it no longer covers, joining pieces that no longer meet;
  - structural: a compound clip that would contain itself; a connected anchor to an item that isn't a storyline clip; moving a storyline clip off the storyline while items are still connected to it. Re-anchoring those items earlier in the same batch makes the move fit;
  - waiting: a pending merge of entries this peer doesn't have yet ([Branches](#branches)), shown again when they arrive.
- **Which anchors fit which items:** clips and gaps go in the storyline; clips and markers connect to a storyline clip or to the origin; a transition sits on the end of a storyline item. An item moves only within its sequence, and a storyline item leaves the storyline only once no connected item or transition is placed by it. A clip's role must be one of its sequence's roles and take its kind of media (a generator is video).
- **A record in use can't be removed:** a role or an asset a live clip uses, a sequence that holds live items or that a live compound clip plays. Adding a removed asset again restores it with the new record.
- **Times stay safe integers.** An operation that would put an item, or a storyline's length, past them is skipped as malformed; an item a later edit pushes past them isn't shown.
- **A removed storyline item stays in the storyline with no length,** so the items after it close up and the items connected to it keep their place as orphans. Restoring it checks it again, as adding would.
- **Setting a leaf of an absent `video` or `audio`** fills in the rest with their defaults: opacity 1, `normal` blend, the identity transform; no gain, pan or fades. `kind`, `anchor`, `cut`, `source` (other than a generator's `source.params.*`) and a role's `sequence` are never set: they change by their own operations or not at all.
- **A split** must fall strictly inside a live clip. The second piece starts at the source point the clip has reached there, plays on from it (down from it in reverse), and keeps the clip's fields, except that the first piece has no fade out and the second no fade in. In the storyline it takes a key between the clip's and the next greater one, so a clip that shares its key with a live item after it can't split. Connected, it takes the clip's anchor that much later, and the split falls where that anchor lands, rounded to the anchor clip's units and snapped to a frame, so the two pieces always meet. Effects stay with the first piece, since an operation makes only one id; the Blade tool copies them in the same batch.
- **A join** needs two live clips of one source, speed, role and sequence, where the second starts at the source point and the time the first ends, on the same anchor. The first takes the second's length and fade out; the second is removed, and what the split moved comes back. A transition on the cut between them, or a keyframe of each at one source point, makes the join skip. Both look only at live items, so a removed one can be restored between the pieces of a split or onto the end of a joined clip; a removed neighbour never blocks an edit.
- **An effect** belongs to a live clip, and changes only while it has one; `effect.set` changes its `position`, `enabled` or a parameter, which keeps its type. **A keyframe** animates an effect's existing parameter, with a value of its type, or one of a clip's `video.*`, `audio.*` or `source.params.*` leaves, with a value that leaf takes; never its timing or its place.
- **Reverting and branching** need the history ([Linear history](#linear-history), [Branches](#branches)): applied without it, a revert or a branch operation is skipped. With it, creating or closing a branch leaves the document as it is; closing `main`, or a branch merging itself, is skipped as structural.
- **Applying reports what to redraw:** for each sequence, a range from the earliest start an operation changed. It runs to the end when what follows can move: after a storyline item, and after a connected clip, which can push later clips of its role to other lanes. A sequence's settings and a role's order redraw the whole sequence; an effect or a keyframe, its clip alone.
- **Applying is deterministic.** A skipped operation is recorded on its entry, so every peer skips the same ones, and the author sees which. Applying uses nothing but the entries: no clock, no random numbers, no locale.
- **A field set replaces the leaf;** the last entry to set a leaf wins. Two people changing different leaves of one clip, one trimming and one grading, both keep their change.

## Linear history

Everyone editing a branch sees the same edits in the same order, and that order never changes under them except in the one case described in [Changing sequencer](#changing-sequencer). Ordering by clock alone, as chat does, can't promise that: an edit made offline would land back in the middle of the history when it arrives. So a **sequencer** gives each batch its place.

### Entries

The sequencer appends each batch it accepts to the branch's history as an entry, and records each one it refuses:

```ts
type Entry = {
  branch: BranchId;
  n: number;                  // 1, 2, 3, … in the branch
  term: number;               // Changing sequencer
  prev: string;               // hash of entry n − 1, or "" for n = 1
  batch: { author: KeyId; seq: number; hash: string };
  sig: string;                // Ed25519 by the sequencer's peer key
};

type Refusal = {
  branch: BranchId;
  batch: { author: KeyId; seq: number; hash: string };
  reason: "signature" | "chain" | "rights" | "format";
  term: number;
  sig: string;                // Ed25519 by the sequencer's peer key
};
```

- The sequencer is **one peer**: for `main`, the first online peer in the project's `sequencers` list, by default the owner's device. Only it writes the branch's history.
- **One order rule:** it appends batches in the order it receives them. Batches it receives together (a reconnecting peer's backlog, or everything pending when it starts a term) are appended in `(hlc, author)` order.
- It appends a batch only after the same author's previous batch on the branch (`branchPrev`) is appended or refused, so each author's edits on a branch stay in the order they made them. A batch for another branch never holds one back.
- It checks a batch's signature, chain and rights before appending it. A batch that fails gets a **refusal**, which settles that seq: the author's next batch can follow it, and the author is told why.
- **The document is the entries applied in order, 1 to n.** Every peer with the same entries has the same document.
- Entries and refusals are signed the way batches are, under the domains `snowy entry v1\n` and `snowy refusal v1\n`. An entry's hash is its `prev` in the next entry and its `hash` in an `EntryRef`.
- An entry that arrives before its batch, or before the entry ahead of it, waits for both; one that doesn't follow the last entry, or names a batch already appended or under another hash, is never applied.

### Pending batches

A batch waits between being committed and being appended. Nobody waits for it:

- Each peer shows the document as **the history, then every pending batch it holds**, in `(hlc, author)` order. The author sees their edit at once; peers see it as soon as it arrives, in the same provisional order, before the sequencer does anything.
- When an entry arrives for a pending batch, the batch moves into the history. The view changes only where the sequencer's order differs from the provisional one and the batches it swaps touch the same items: which value of a leaf wins, which of two items at the same position comes first, which operation is skipped. Edits a few milliseconds apart are the only ones that swap.
- Pending batches are shown as such in the history, below the last entry.
- A peer keeps the entries' document apart from the shown one. An entry that appends the first batch shown changes nothing shown; any other entry shows the pending batches again, from the entries' document, and the ranges to redraw are those both showings touched.
- **The sequencer being away doesn't stop anyone.** Peers keep editing, and their batches stay pending, ordered the same way on every peer.
- **Offline edits** are pending batches of the peer that made them. The sequencer receives them when the peer reconnects, so they are appended after everything already in the history, with their `base` showing what the author had seen.

### Concurrent edits

An entry is **concurrent** if an entry by another author, between its batch's `base` and itself, touched an item or leaf it touches: its author couldn't see that change. Concurrency is worked out when the entry is applied, so every peer marks the same entries. An operation the entry skipped touches nothing. Setting a leaf touches that leaf, and a keyframe its target's parameter at its source point; moving, removing, restoring, splitting or joining an item touches all of it, so it clashes with any leaf of it; adding touches nothing, since the new id is the entry's own, except adding an asset, which touches it: its id is its content's, so two authors can add the same one. Two leaves of one item don't clash. The history shows the mark, and an agent is told, so a person can look at that edit again. Nothing is refused or merged by hand.

### Changing sequencer

The project's `sequencers` list names who may sequence `main`, in priority order; the owner signs it.

```ts
type Term = {
  branch: BranchId;
  term: number;               // one more than the term it follows
  sequencer: KeyId;
  after: EntryRef;            // the last entry it continues from
  sig: string;                // Ed25519 by that sequencer's peer key
};
```

- A branch's first sequencer appends in term 1, with no `Term`: the first in `sequencers` for `main`, the creator for any other branch.
- A listed peer becomes a **candidate** when every peer listed before it is gone and no sequencer is active. It learns both from presence: `@snowy-media/sync` reports every peer that comes and goes, and nothing waits on a timer.
- **A candidate catches up first.** It sends its version vectors to every connected peer and takes in every valid entry they reply with, signed by an earlier sequencer of the branch. When every peer has replied or gone, it starts a term after the end of the longest chain it holds. A peer that was offline for a day therefore continues from today's history, not its own.
- A sequencer that sees a higher term from a peer listed before it stops sequencing.
- An active sequencer that sees a higher term from a peer listed *after* it starts a newer term itself. A peer that starts a term early, by mistake or on purpose, therefore can't take over from an active sequencer listed before it.
- A sequencer that returns doesn't take over again while another is active, so control doesn't flip back and forth.
- **The one case where the history's tail changes:** entries no peer the new sequencer could reach had received, and two candidates starting the same term at once. Entries after a term's `after` that aren't in its chain are dropped, and of two terms with the same number, the one whose sequencer is listed first wins. Their batches are still in their authors' logs, so they go back to pending and the new sequencer appends them again. The history shows them as *resequenced*.
- **Entries are named by `EntryRef`, `n` and hash together,** wherever one is referred to (branch starts, merges, reverts). A reference to a dropped entry is then recognisably stale instead of silently naming the entry that took its number.

## Undo, revert and going back

None of these rewrites history. Each is a new batch, so it can itself be undone, and everyone sees it.

| Action | What it does |
| --- | --- |
| **Undo** | A batch with `undoes` naming one of the author's own batches, by default their latest on the branch that isn't an undo, isn't undone, and applied an operation undo can take back (not only reverts and branch operations) |
| **Redo** | An undo of the undo, by default the author's latest undo that isn't undone, if no edit of theirs came after it |
| **Revert a batch** | The same as undo, for any author's batch: "take back what Claude did in entry 212", even after later edits |
| **Revert to an entry** | One `revert` operation naming an `EntryRef`. Applying it sets every item and leaf to its state at that entry, worked out from the nearest snapshot and the entries after it, so the batch stays small whatever the project's size. |
| **Go back** | A read-only view of the document at any entry, the same way. Nothing changes until the user reverts or branches. |
| **Branch out** | A new branch from any entry |

An undo's operations are worked out when it is committed, from the document its author sees, and applied like any batch's, with the same skipping:

- **A leaf the batch set** is set back, if it still has the value the batch gave it. If someone has changed it since, it is left alone, and the undo reports it. An optional leaf the batch set for the first time, such as a clip's first name, is reported too, since setting can't clear a leaf.
- **A record the batch added** (a sequence, role, item, effect or asset) is removed, unless someone has changed it since: then it is left, and reported. Setting a leaf of, or moving, a record the same batch added needs nothing more.
- **An item the batch removed** is restored, with its state, and **an item it restored** is removed, if the item is as the batch left it. A sequence, role or effect it removed stays removed and is reported, since only items have a restore.
- **A move** is moved back to the anchor it had, if the item still has the one the batch gave it.
- **A keyframe the batch set** is removed if it was new, or set back to its earlier value and ease, if it still has the ones the batch gave it; **one it removed** is set again, if nothing has been set there since.
- **A split** is undone with `clip.join`, if both pieces are as the split left them, which also takes back the connected items and keyframes the split moved, since both are anchored to source points. **A join** is undone with `clip.split` where the first piece ended, if the clip is as the join left it; the second piece then has a new id.
- **A revert** isn't undone: reverting to the entry before it does that. Branch operations aren't undone either.
- The batch's operations are undone last first, each against the document as the undo's operations so far leave it, compared with the batch's own document taken back the same way. A leaf the batch set on an item it then removed is set back once the item is restored, and a clip it cut in three is joined back whole.
- What an undo leaves alone is reported per operation, with why. A batch is undone against the document as shown, pending batches included, so the author's latest edit can be undone before the sequencer has appended it.

Undo is per author: undo takes back your edits, never someone else's that came after them.

Reverting to an entry sets each record to its state at that entry. A record added after it is removed, keeping its state and id, so a later batch can restore it. Keyframes are those of that entry. A revert naming an entry the branch doesn't have under that hash, such as one a new term dropped, is skipped as stale. It redraws every sequence, and touches every item for telling concurrent entries.

The history keeps the entries' document every `SNAPSHOT_EVERY` entries in memory, so going back to an entry or reverting to it applies fewer than that many entries. It also keeps the document after every entry that holds a revert, so the entries it applies never hold one; memory grows with the number of reverts. A revert to the last entry, part way through a batch, reverts to the document before that batch, as it did while the batch was pending. Since a pending revert's result depends on the entries the peer had, its entry always shows the pending batches again.

## Branches

A branch is its own linear history that starts at an entry of another branch.

```ts
type Branch = {
  id: BranchId;               // the id of the branch.create operation
  name: string;
  from?: { branch: BranchId; entry: EntryRef };  // none for main
  sequencer: KeyId;           // its creator
  closed: boolean;
};
```

- `main` is the project's first branch, sequenced by the project's `sequencers` list. Any other branch is sequenced by its creator, with no standby: while the creator is away, the branch's batches stay pending.
- **Creating** a branch is a `branch.create` entry on the branch it starts from. The new branch's document starts as that branch's document at that entry.
- **Merging** is a `branch.merge` entry on the target branch, naming the branch and either everything up to an entry or chosen entries. Applying it applies those entries' operations at that point, in the branch's order, with the usual skipping, each with the id it has on its branch. The target's history stays linear: the merge is one entry, which the history can expand into the edits it brought.
- **Each batch is merged once.** A document keeps the batches applied to it, its branch's start included, as each author's runs of seqs, and a merge passes over those it has. Merging a branch twice brings only its new entries, and merging the target back into the branch brings only what the branch lacks. A revert leaves the batches it took back counted, so merging them again doesn't bring them back.
- **A merge brings what its branch merged.** A merge among the merged entries brings its own entries in turn, so a branch catching up with `main` also gets what `main` merged from other branches. A revert, `branch.create` or `branch.close` among them is skipped: it names the other branch's entries.
- **A merge waits for its entries.** An entry whose batch merges entries this peer doesn't have yet waits for them, as an entry waits for its batch; the sequencer appends such a batch only once it has them. A merge naming an entry its branch has under another hash is skipped as stale. A merge naming a branch or an entry that never comes waits for ever, and so do its author's later batches on that branch, which follow it. Since a pending merge's result depends on the entries the peer had, its entry always shows the pending batches again.
- **Merging is always possible.** Operations name items by id, never by position in a list, so they still apply after other edits. A merge is marked concurrent if what it brings touches an item or leaf that a batch on the target changed since the branch started, unless the branch's document at the last entry merged has that batch: the merged edits' authors couldn't see the others. Edits a branch merged before therefore don't clash with its later ones. For a branch started from another branch, the change counts since the merging batch's `base`.
- **A branch exists once its creating entry is applied.** Batches and entries for a branch this peer hasn't created yet wait for it, so an editor can't commit to a branch before its `branch.create` is appended.
- **Closing** a branch is a `branch.close` entry, on any branch. Its sequencer appends nothing more to it; its history stays, and batches still pending there stay pending. `main` can't be closed.

## Agents

An agent edits the same way a person does: it commits batches under its own peer key, so its edits are signed as its own, shown in the history under its name, and undone and reverted like anyone's.

### Permission

The person who connects an agent chooses how it edits:

| Setting | The agent's batches go to |
| --- | --- |
| **Edit freely** | The branch the person is on, like the person's own edits |
| **Ask first** | A proposal branch the agent creates from where it starts and sequences itself. The person sees the proposal as a diff and a preview, and merges all of it, some of its entries, or none. |

- Either way every edit is in a history, so it can be looked at, undone, reverted or branched from. Asking first changes when an edit reaches everyone, not whether it can be taken back.
- An agent can't have more rights than the person who connected it, nor more than the project allows ([Identity and rights](#identity-and-rights)).
- **Actions outside the document always ask,** whatever the setting: writing or deleting files, sharing the project or its media, and granting rights. History can't take those back. They belong to the editor, not to this package.

### What the package gives agents

- **JSON Schemas** for every operation and query, generated from this package's types. The editor's tool registry, shaped like WebMCP's `registerTool`, wraps them.
- **A dry run:** `preview(ops)` returns what the batch would change (items, times, lanes, skipped operations) without committing it.
- **A text form** of a sequence that is cheap to read: one line per item, with its time, source, range, role and anchor, for a range of the sequence. Each author's key is printed as a short alias (`a1`, `a2`, …) listed in the header, in order of first appearance in the history, so an id prints as `a1.12.0`. Operations accept that short form, which maps back to exactly one id.

```text
sequence a1.1.0  24000/1001  1920x1080  48 kHz
authors  a1 = 9vQx…  a2 = Kp3m…
storyline
  00:00:00:00  a1.4.0   clip  interview.mov#0  in 00:01:02:03  dur 00:00:08:12  Dialogue
  00:00:08:12  a1.4.1   gap                                   dur 00:00:01:00
  00:00:09:12  a2.7.0   clip  interview.mov#0  in 00:02:40:00  dur 00:00:05:00  Dialogue
connected
  00:00:03:00  a2.9.0   clip  broll.mp4#0      in 00:00:10:00  dur 00:00:03:00  B-roll  lane 1  on a1.4.0 at 00:01:05:03
  00:00:00:00  a1.5.0   clip  score.wav#0      in 00:00:00:00  dur 00:00:14:12  Music   lane 1  at origin
```

- **Notifications:** an agent sees every entry and pending batch as events, so it reacts to other people's edits instead of polling.

## Identity and rights

| Key | Type | Held by | Purpose |
| --- | --- | --- | --- |
| **Project key** | Ed25519 key pair | The owner | Signs the project record, its sequencer list and rights grants. `ProjectId` is its public key. |
| **Peer key** | Ed25519 key pair, one per device or agent per project | Every person's device and every agent | Signs batches, and entries, refusals and terms when sequencing. `KeyId` is its public key. |

Private keys are non-extractable `CryptoKey`s, which the editor keeps in IndexedDB; the package is handed them, never stores them.

| Right | May |
| --- | --- |
| `view` | Read the project |
| `propose` | Commit `branch.create` on any branch it can see, and anything on branches it created |
| `edit` | Commit batches to any branch it can see, and create branches |

- **Who sequences isn't a right.** `main`'s sequencers are the signed `sequencers` list in the project record, and any other branch is sequenced by its creator.
- **Grants**, which give a key its rights, are `@snowy-media/sync`'s: signed by the project key, or passed on by a key that holds the rights, for at most those rights. Sync carries every peer's grants, and the package receives them with `receive`. The sequencer appends only batches the author's rights allow, and every peer checks the same before showing a batch as pending.

## The project folder

The project lives in a folder the user picks (`showDirectoryPicker`, read and write), next to their media if they like. The editor writes it; the package tells it what to write.

```text
<project folder>/
  project.json                  the signed project record and grants
  logs/<KeyId>/<first seq>      each author's batches, in segments
  history/<BranchId>/<first n>  each branch's entries, refusals and terms, in segments
  assets/<AssetId>/             what the editor derives from each asset:
    index                         keyframe index
    waveform                      min/max pyramid
    thumbnails
    analysis/…                    transcript, shots, loudness
```

- **Only the editor writes the folder,** from the package's `write` events, for local edits and for objects received through `@snowy-media/sync` alike. Sync never writes it; it reads from it, through the editor, to answer a peer's repair.
- **Every author's log and every history is kept** by every peer that edits the project, so any peer can rebuild the document, serve a peer that missed something, or become the sequencer.
- **Logs are segmented.** Chromium writes a `FileSystemWritableFileStream` to a temporary file and replaces the original on `close`, copying the existing file first when appending. Appending to one growing file would therefore copy all of it on every batch; a segment bounds the copy. A batch counts as saved when its write closes.
- **A segment is records**, each a 4-byte big-endian length and an object's canonical bytes, as it is signed. A new segment starts when the next record would take the last one past the segment size, or when the last one ends in a record cut short, and is named by the first seq or `n` in it, or one past the segment before if that is higher, so no segment is written over. A `write` names a path, the offset to write at, which is the file's length so far, and the bytes: the editor opens the file keeping its data and writes there.
- **A batch is written once,** when it is committed here or first received, and an entry once, when it is applied. Pending batches are in their authors' logs, so they are pending again when the project opens.
- **Opening a project** reads every log and history and checks each batch and entry as if it had just arrived: signature, its author's chain, the sequencer's signature, and that each entry follows the last. A file holding one that doesn't pass, or a record that doesn't read, is reported, and the rest opens, including the records of that file that do read; an entry whose batch is in such a file waits for it, as an entry received without its batch would, and the sequencer appends nothing to that branch until it applies, so it never signs a second entry with the number of one it read. An entry lost from a history cut short is gone for the sequencer too: it signs that number again, and a peer holding the lost entry refuses the new one unless it names the same batch.
- **No document is saved.** Opening applies every entry again, since applying is a small part of opening. `openFolder` on a project of one author's 4,000 entries on main, each adding a clip, took 430 ms in Playwright's Chromium on an Apple M5: about 80 ms reading and decoding the files, 170 ms checking and hashing the batches, and 160 ms pending and appending the entries, which checks and hashes each of them. Applying the 4,000 batches alone took 6 ms. Every batch and entry is still checked before it is trusted, so a saved document would spare only those 6 ms, and would bring a format of its own and a way to tell it stale. Checking Ed25519 signatures in parallel is no faster than one at a time.
- **One tab writes a project.** The editor takes a Web Lock named after the project; another tab opening it gets the lock only when the first lets go, and until then is read-only and doesn't join the project's session.
- A collaborator picks their own project folder when they join. Their folder holds the same logs and histories. Media they don't have on disk arrives through `@snowy-media/sync`, which keeps it in its own store.

## Queries and the render plan

| Query | Returns |
| --- | --- |
| `at(sequence, t)` | Every item active at time `t`, in compositing order |
| `range(sequence, from, to)` | Every item that overlaps the range |
| `gaps(sequence)`, `edits(sequence)` | Gaps, and edit points with what lies on each side |
| `diff(a, b)` | What changed between two entries, or between two branches |
| `history(branch, from, to)` | Entries with author, label, skipped operations and concurrency marks |
| `plan(sequence, from, to)` | The render plan |

**The render plan** is what `@snowy-media/engine` plays and exports. It cuts the range into segments in which the set of active layers and transitions doesn't change, and for each segment lists:

- **video layers**, bottom to top in compositing order ([Layout](#layout)): the source, the in-point in stream units and the speed, the effect chain, transform, opacity and blend;
- **audio layers**: the source, the in-point and speed, the effect chain, gain and pan, fades, and the bus of the clip's role.

```ts
type Layer = {
  clip: ItemId;
  source: { asset: AssetId; stream: number } | { generator: string; params: Record<string, Animated> } | { sequence: ItemId };
  in: number;                 // the clip's in-point, in timeBase units
  timeBase: [number, number]; // the stream's; [1, 705600000] for a generator or a sequence
  start: number;              // where the clip starts on the timeline, in microseconds
  end: number;                // and where it ends; a transition plays it past start or end
  speed: [number, number];
  effects: Array<{ id: ItemId; kind: string; params: Record<string, Animated> }>;
};
type Animated = Value | { keyframes: Array<{ at: number; value: Value; ease: Ease }> };   // at in microseconds
```

- **A layer is its whole clip,** not the part in its segment: the source time at timeline time `t` is `in + (t − start) × speed`, converted to `timeBase`, so a layer that spans several segments reads its source the same way in each, and is the same object in each. A layer may start before its segment and before the range. Source times are the stream's own timestamps, as FFmpeg reports them, so the engine seeks by them as they are.
- **Keyframes are at their times on the timeline,** in time order, worked out from their source points through the clip's in-point and speed, so the engine evaluates a parameter at a time without knowing the clip. A parameter without keyframes is its value.
- **Fades** are the times the fade in ends and the fade out starts, and shape the clip between its `start` and `end`; past them, over a transition, the transition's effect shapes it.
- Disabled clips, clips of no length and disabled effects play nothing, nor do gaps and markers. A connected clip whose clip is removed plays where that clip was, as [Anchors](#anchors) says.
- **A clip is a layer of its role's kind.** A compound clip in a video role is its sequence's picture, which the engine draws from that sequence's own plan; in an audio role, it is that sequence's mix. The plan carries the sequence's record, so the engine sizes the picture and the mix from it.
- **A transition** plays in the segments over its cut, which list it with its effect, its parameters, its times and the clips on each side, `out` before the cut and `in` after it. Both clips are layers there: the one after the cut plays early, from its media before its start, and the one before plays on, from its media past its end; a side that is a gap or a disabled clip has none. The engine draws the two through the transition's effect. Each half of a transition shortens to the media its side has, in whole frames, and to half the item next to the cut, so two transitions on one item never meet. A transition with no clip on either side plays nothing. Of two transitions on one cut, made at once, the first by id plays.

Segment times are microseconds, converted from flicks there and only there, rounded to the nearest, halves upwards. Source in-points stay in stream units, so the engine picks the exact frame. The plan also lists the layers that start where the range ends, so the engine can seek their sources and start their decoders before the cut.

## Calls and events

The package acts only when it is called:

| Call | When |
| --- | --- |
| `load(files)` | Opening a project: the project record, grants, logs and histories, as read from the project folder |
| `commit(ops, label)` | The user or an agent makes an edit |
| `receive(object)` | A batch, entry, refusal, term or grant arrives from `@snowy-media/sync` |
| `verify(bytes)` | `@snowy-media/sync` asks what an object is: a batch's `{ author, seq }`, a history object's `{ branch, term, n, hash }`, or invalid |
| `presence(peers)` | The set of online peers changes, from `@snowy-media/sync`'s announce and unannounce events |
| `sequence()` | This peer is the active sequencer and has received batches; it returns the entries and refusals to publish |

It reports what happened as events:

| Event | When | Carries |
| --- | --- | --- |
| `changed` | The document changed: a commit, a pending batch, an entry, a revert, a resequenced tail | The items changed, and the time range affected in each sequence, so the editor redraws and the engine drops cached frames only there |
| `pending` | A batch is committed here or received | The batch |
| `entry` | A batch is appended to a history | The entry, its skipped operations, whether it is concurrent |
| `refused` | A batch was refused | The refusal |
| `term` | A sequencer starts a term | The term, and any batches gone back to pending |
| `catch-up` | This peer became a candidate sequencer | The version vectors to send |
| `write` | Something must be written to the project folder | The path and the bytes |

## Requirements on @snowy-media/sync

| Capability | Used for |
| --- | --- |
| **Projects as sessions,** joined with grants that carry `view`, `propose` and `edit`, passed on from a person to an agent, and carried to every peer | Editing together, and checking rights |
| **An author log per peer**, like chat's: batches repaired on reconnect by version vector, including the batches of agents a tab carries | Every batch reaching every editor |
| **A history track per sequencer**, under its own namespace, for each branch it sequences, repaired by `{ term, n, hash }` | Entries, refusals and terms, with one writer per track |
| **Presence that isn't stored:** selections, playheads, drag previews, and every peer and agent coming and going | Seeing what others do as they do it, and choosing the sequencer without a timer |
| **Assets served by any editor that has them:** each peer whose file matches an asset can serve its chunks, and one session carries many assets from many peers | Collaborators without the file |
| **Opaque content:** sync orders and repairs objects by the fields the package's `verify` returns, and never reads or writes them | Keeping the packages apart |

## Requirements on @snowy-media/engine

| Capability | Used for |
| --- | --- |
| **Playing a render plan:** several sources, each from its own `FileSystemFileHandle` or from `@snowy-media/sync`, composited and mixed as the plan says | Preview |
| The player as a one-clip plan, so player and editor share one path | One code path |
| **Starting decoders ahead of a cut** from the plan's next sources | Cuts without a stall |
| **An effect registry:** each effect kind a WGSL or audio processing stage, with typed parameters | Effects |
| **Frame-exact seek and frame grabs** at any timeline time | Scrubbing, thumbnails, agents looking at a frame |
| **Rendering a plan offline,** paced by the encoder, not the clock, into an encoder and muxer | Export |
| **Invalidating cached frames** for a time range | `changed` |

## Constants

| Name | Value |
| --- | --- |
| Flicks per second | 705,600,000 |
| `SNAPSHOT_EVERY` | 512 entries, kept in memory for going back, until measured |
| Log and history segment size | 1 MiB, until measured |
| HLC | The format and rules of `@snowy-media/sync`'s chat |

## Limits

- One storyline per sequence. A group of connected items that must move together is a compound clip.
- Connected items anchor to storyline clips or the origin, not to each other.
- Speed is constant per clip.
- A title's text is one leaf: two people typing in the same title at once keep the later text, not both.
- A batch is at most 1 MiB in canonical bytes.
- Two different files of the same size whose first and last MiB are identical are one asset.
- A branch other than `main` has no standby sequencer.

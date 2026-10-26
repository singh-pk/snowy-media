# Agent guide: @snowy-media/timeline

The [root AGENTS.md](../../AGENTS.md) applies here too; this file adds what is specific to this package. Paths below are relative to `packages/timeline/`.

This package is the edit document of the Snowy editor: a magnetic timeline of sequences, clips and anchors, the operations that change it, and the linear history every person and agent editing a project shares. It has no DOM, network, storage or media. Read [docs/architecture.md](docs/architecture.md) before changing it; code follows that design, and a change to the design changes that document in the same pull request.

## Commands

| Task | Command |
| --- | --- |
| Tests (Chromium) | `bun run test` |
| Typecheck | `bun run typecheck` |

## Map

| Path | What it holds |
| --- | --- |
| `src/time.ts` | flicks: frame lengths, exact conversions from time bases and through speed, and snapping to frames |
| `src/ids.ts` | key ids and item ids, `<author>.<seq>.<index>` |
| `src/position.ts` | position keys: fractional indexes that order a storyline and fit between any two |
| `src/storyline.ts` | a storyline's layout: items in position order in a balanced tree, with each item's start and the item at a time in O(log n) |
| `src/layout.ts` | connected items: the time a clip or origin anchor gives, and each role's lanes |
| `src/schema.ts` | schemas that check untrusted JSON and return it in canonical shape |
| `src/document.ts` | the document's records and every operation, as schemas |
| `src/signed.ts` | signed objects: canonical bytes, signing under a domain, checking and hashing |
| `src/batch.ts` | batches, as signed objects |
| `src/entry.ts` | entries and refusals, as signed objects |
| `src/project.ts` | a project's document: what a peer reads of it, and applying batches to it |
| `src/records.ts` | the document's records by id, removed ones included, the indexes kept in step, and looking up a live record |
| `src/skip.ts` | skipping an operation that doesn't fit, with the kind of reason the design names |
| `src/leaf.ts` | a record's leaves: which paths `*.set` may change, defaults for a clip's absent video and audio, and a record with one leaf set |
| `src/placement.ts` | where an item goes: the sequence its anchor puts it in, what a clip needs besides, where it starts and what its change redraws |
| `src/edits.ts` | the operations that add, set, move, remove and restore one record: items, assets, sequences, roles, effects and keyframes |
| `src/cuts.ts` | splitting a clip and joining two pieces back, handing over what sits on them |
| `src/apply.ts` | applying a batch: each operation checked and applied or skipped, what merges bring, and the ranges to redraw |
| `src/queries.ts` | what a peer reads of a document: items, storylines, transitions, lanes, effect chains and keyframes |
| `src/snapshot.ts` | a project's snapshot, which another project starts from, and reverting to one |
| `src/serial.ts` | calls that run one at a time, in the order they are made |
| `src/history.ts` | one branch's history: entries applied in order, then the pending batches, the sequencer appending them, going back, reverting and what to undo |
| `src/concurrent.ts` | what each operation touches, and whether an entry clashes with one its author hadn't seen |
| `src/undo.ts` | the operations that undo a batch, from the documents before and after it and now |
| `src/branches.ts` | a project's branches: each one's history, created and closed by entries, and what waits for a branch or for merged entries |
| `src/folder.ts` | the project folder: logs and histories in segments, what to write, and opening a project from its files |
| `src/plan.ts` | the render plan: a range of a sequence cut into segments of video and audio layers and the transitions between them, for the engine |
| `test/` | unit tests (`*.unit.ts`), run in Chromium by `unit.test.ts` |

## Rules

1. **Operations are the only way in.** Nothing changes the document except applying a batch of operations from the history or the pending batches.
2. **Applying is deterministic.** Never use a clock, random numbers, the locale or iteration order that differs between runs while applying entries; every peer must reach the same document.
3. **Append only.** Never rewrite or delete a batch or a removed item's state, and never rewrite an entry. The one exception is the design's: a new sequencer's term replaces entries its predecessor appended that it never received. Undo and revert are new batches.
4. **Positions are derived.** Never store a time that layout can work out from anchors and durations.
5. **Event-driven only.** No `setTimeout` or `setInterval`, and no polling. The package acts only when it is called.
6. **Pure.** No dependency on another Snowy package, and no browser-only API, so it runs in Bun.
7. **Rights come from grants only.** Who may edit is decided by signed grants alone; any further limit on who edits is the app's policy, applied outside the package.

## Review

Beyond the rules above and [docs/architecture.md](docs/architecture.md), a reviewer checks:

- **Determinism.** Nothing depends on when or in what order something arrived rather than on its place in the history (rule 2). A test of a new operation replays it on a fresh document and compares.
- **Small operations.** An operation names what changed, not the whole object it changed.

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Branches (src/branches.ts), in Chromium: a branch starts from the document at its creating entry
// and is sequenced by its creator, a merge brings a branch's edits once each, what waits for a
// branch or for merged entries is applied when they arrive, and a closed branch takes no more.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import type { Batch } from "../src/batch";
import { createBranches } from "../src/branches";
import { entries as entryFormat, type Entry } from "../src/entry";
import { author, fail, rename } from "./support/history";
import type { Op } from "./support/project";

// Two authors and their project, sequenced by `a`, where `b` has created the branch "Alt" in
// main's second entry. Every batch and entry made is kept, to hand another peer.
async function setUp() {
  const a = await author();
  const b = await author();
  const branches = createBranches({ sequencer: a.key });
  const batches: Array<{ batch: Batch; hash: string }> = [];
  const entries: Entry[] = [];
  let clock = 0;

  const historyOf = (branch: string) => branches.history(branch) ?? fail();

  // Commits a batch on `branch` and runs both sequencers, unless `pending`.
  async function edit(by: typeof a, branch: string, ops: Op[], pending = false) {
    clock += 1;
    const hlc = clock.toString(16).padStart(16, "0");
    const { batch, hash } = await by.commitTo(branch, ops, hlc, historyOf(branch).head());
    batches.push({ batch, hash });
    await branches.pend(batch, hash);
    if (pending) return { batch, entered: [] };
    const byA = await branches.sequence(a.peer);
    const byB = await branches.sequence(b.peer);
    entries.push(...byA.entries, ...byB.entries);
    const entered = [...byA.changes.values(), ...byB.changes.values()].flatMap(
      (change) => change.entered,
    );
    return { batch, entered };
  }

  await edit(a, "main", [rename("One")]);
  await edit(b, "main", [{ op: "branch.create", name: "Alt" }, rename("Two")]);
  const alt = `${b.key}.1.0`;
  return { a, b, branches, batches, entries, edit, historyOf, alt };
}

test("a branch starts from the document at its creating entry and is sequenced by its creator", async () => {
  const { a, b, branches, edit, historyOf, alt } = await setUp();
  const main = historyOf("main");
  expect(branches.branches()).toEqual([
    { id: "main", name: "main", sequencer: a.key, closed: false },
    {
      id: alt,
      name: "Alt",
      from: { branch: "main", entry: main.head() },
      sequencer: b.key,
      closed: false,
    },
  ]);
  // The whole creating batch is applied, the operations after the creation too.
  expect(historyOf(alt).document().name()).toBe("Two");

  await edit(b, alt, [rename("Three")], true);
  await branches.sequence(a.peer);
  expect(historyOf(alt).pending()).toHaveLength(1);
  const { entries } = await branches.sequence(b.peer);
  expect(entries.map(({ branch, n }) => [branch, n])).toEqual([[alt, 1]]);
  expect(historyOf(alt).document().name()).toBe("Three");
  expect(main.document().name()).toBe("Two");
});

test("a batch or entry for a branch not created here yet waits for it", async () => {
  const { a, b, batches, entries, edit, historyOf, alt } = await setUp();
  await edit(b, alt, [rename("Three")]);
  const other = createBranches({ sequencer: a.key });
  const onAlt = batches.filter(({ batch }) => batch.branch === alt);
  const onMain = batches.filter(({ batch }) => batch.branch === "main");

  for (const { batch, hash } of onAlt) await other.pend(batch, hash);
  // One signed by someone other than the branch's sequencer waits too, and is dropped once the
  // branch is here to refuse it.
  const onAltEntries = entries.filter(({ branch }) => branch === alt);
  const { sig: _, ...unsigned } = onAltEntries[0] ?? fail();
  const forged = await entryFormat.sign(a.peer.privateKey, unsigned);
  await other.append(forged);
  for (const entry of onAltEntries) await other.append(entry);
  expect(other.history(alt)).toBe(undefined);

  for (const { batch, hash } of onMain) await other.pend(batch, hash);
  for (const entry of entries.filter(({ branch }) => branch === "main")) await other.append(entry);
  const copy = other.history(alt) ?? fail();
  expect(copy.entries()).toEqual(historyOf(alt).entries());
  expect(copy.document().snapshot()).toEqual(historyOf(alt).document().snapshot());
});

test("a merge brings a branch's edits to the target once each, with their own ids", async () => {
  const { a, b, edit, historyOf, alt } = await setUp();
  const added = await edit(b, alt, [
    {
      op: "sequence.add",
      sequence: { name: "Alt cut", rate: [24, 1], width: 1920, height: 1080, sampleRate: 48_000 },
    },
  ]);
  await edit(b, alt, [rename("Alt")]);
  const through = historyOf(alt).head();
  const { entered } = await edit(a, "main", [{ op: "branch.merge", branch: alt, through }]);
  const main = historyOf("main").document();
  expect(main.name()).toBe("Alt");
  expect(main.sequence(`${b.key}.${added.batch.seq}.0`)?.name).toBe("Alt cut");
  expect(entered[0]?.merged.map(({ batch }) => batch.seq)).toEqual([2, 3]);

  // Merging again brings nothing, and merging main back brings only what the branch lacks.
  const again = await edit(a, "main", [{ op: "branch.merge", branch: alt, through }]);
  expect(again.entered[0]?.merged).toEqual([]);
  await edit(a, "main", [rename("Main")]);
  const back = await edit(b, alt, [
    { op: "branch.merge", branch: "main", through: historyOf("main").head() },
  ]);
  const brought = back.entered[0]?.merged.map(({ batch }) => [batch.author, batch.seq]);
  expect(brought).toEqual([
    [a.key, 2],
    [a.key, 3],
    [a.key, 4],
  ]);
  expect(historyOf(alt).document().name()).toBe("Main");
  // The merges among them bring nothing more: the branch has what they merged.
  expect(back.entered[0]?.merged.flatMap(({ skipped }) => skipped)).toEqual([]);
});

test("a merge of chosen entries applies them in the branch's order, and a stale one is skipped", async () => {
  const { a, b, edit, historyOf, alt } = await setUp();
  await edit(b, alt, [rename("Three")]);
  const first = historyOf(alt).head();
  await edit(b, alt, [rename("Four")]);
  const second = historyOf(alt).head();
  await edit(b, alt, [rename("Five")]);
  const third = historyOf(alt).head();
  await edit(a, "main", [{ op: "branch.merge", branch: alt, entries: [second, first, third] }]);
  expect(historyOf("main").document().name()).toBe("Five");

  const { entered } = await edit(a, "main", [
    { op: "branch.merge", branch: alt, entries: [{ n: 1, hash: second.hash }] },
  ]);
  expect(entered[0]?.skipped.map(({ reason }) => reason)).toEqual(["stale"]);
});

test("an entry merging entries this peer doesn't have yet waits for them", async () => {
  const { a, b, batches, entries, edit, historyOf, alt } = await setUp();
  await edit(b, alt, [rename("Three")]);
  await edit(a, "main", [rename("Main")]);
  const merge = await edit(a, "main", [
    { op: "branch.merge", branch: alt, through: historyOf(alt).head() },
  ]);
  const other = createBranches({ sequencer: a.key });

  for (const { batch, hash } of batches.filter((each) => each.batch.branch === "main"))
    await other.pend(batch, hash);
  for (const entry of entries.filter(({ branch }) => branch === "main")) await other.append(entry);
  const main = other.history("main") ?? fail();
  expect(main.head().n).toBe(3);
  const entered = [];

  for (const { batch, hash } of batches.filter((each) => each.batch.branch === alt))
    await other.pend(batch, hash);

  for (const entry of entries.filter(({ branch }) => branch === alt)) {
    const changes = await other.append(entry);
    entered.push(...(changes.get("main")?.entered ?? []));
  }

  expect(main.entries()).toEqual(historyOf("main").entries());
  expect(main.document().snapshot()).toEqual(historyOf("main").document().snapshot());
  // Both peers mark the merge alike.
  expect(
    entered.map(({ skipped, merged, concurrent }) => ({ skipped, merged, concurrent })),
  ).toEqual(
    merge.entered.map(({ skipped, merged, concurrent }) => ({ skipped, merged, concurrent })),
  );
  expect(entered[0]?.concurrent).toBe(true);
});

test("the sequencer holds back a merge of entries it doesn't have, and appends it once they arrive", async () => {
  const { a, b, batches, entries, edit, historyOf, alt } = await setUp();
  const other = createBranches({ sequencer: a.key });
  for (const { batch, hash } of batches) await other.pend(batch, hash);
  for (const entry of entries) await other.append(entry);
  const onAlt = await edit(b, alt, [rename("Three")]);
  const merging = await a.commitTo(
    "main",
    [{ op: "branch.merge", branch: alt, through: historyOf(alt).head() }],
    "00000000000000ff",
    historyOf("main").head(),
  );
  await other.pend(merging.batch, merging.hash);
  const held = await other.sequence(a.peer);
  expect(held.entries).toEqual([]);

  await other.pend(onAlt.batch, batches.at(-1)?.hash ?? fail());
  for (const entry of entries.filter(({ branch }) => branch === alt)) await other.append(entry);
  const { entries: made } = await other.sequence(a.peer);
  expect(made.map(({ branch, n }) => [branch, n])).toEqual([["main", 3]]);
  expect(other.history("main")?.document().name()).toBe("Three");
});

test("a merge brings what the branch got by merging, so catching up loses nothing", async () => {
  const { a, b, edit, historyOf, alt } = await setUp();
  const created = await edit(b, "main", [{ op: "branch.create", name: "Alt 2" }]);
  const alt2 = `${b.key}.${created.batch.seq}.0`;
  await edit(b, alt, [rename("From alt")]);
  await edit(a, "main", [{ op: "branch.merge", branch: alt, through: historyOf(alt).head() }]);
  const { entered } = await edit(b, alt2, [
    { op: "branch.merge", branch: "main", through: historyOf("main").head() },
  ]);
  expect(historyOf(alt2).document().name()).toBe("From alt");
  // Main's merge, and through it alt's rename.
  expect(entered[0]?.merged.map(({ batch }) => batch.author)).toEqual([a.key, b.key]);
  expect(entered[0]?.merged[0]?.skipped).toEqual([]);
});

test("a merge's edits are applied by their own rules: a revert among them is skipped", async () => {
  const { a, b, edit, historyOf, alt } = await setUp();
  await edit(b, alt, [{ op: "revert", to: { n: 0, hash: "" } }, rename("Reverted")]);
  const { entered } = await edit(a, "main", [
    { op: "branch.merge", branch: alt, through: historyOf(alt).head() },
  ]);
  expect(entered[0]?.merged[0]?.skipped.map(({ index, reason }) => [index, reason])).toEqual([
    [0, "unsupported"],
  ]);
  expect(historyOf("main").document().name()).toBe("Reverted");
  // On the branch the revert went back to the branch's start, which is main's second entry.
  expect(historyOf(alt).document().name()).toBe("Reverted");
});

test("going back across a merge, and reverting it, leave its batches counted", async () => {
  const { a, b, edit, historyOf, alt } = await setUp();
  const before = historyOf("main").head();
  await edit(b, alt, [rename("Three")]);
  const through = historyOf(alt).head();
  await edit(a, "main", [{ op: "branch.merge", branch: alt, through }]);
  const after = historyOf("main").head();
  expect(historyOf("main").at(before).name()).toBe("Two");
  expect(historyOf("main").at(after).name()).toBe("Three");

  await edit(a, "main", [{ op: "revert", to: before }]);
  expect(historyOf("main").document().name()).toBe("Two");
  const again = await edit(a, "main", [{ op: "branch.merge", branch: alt, through }]);
  expect(again.entered[0]?.merged).toEqual([]);
  expect(historyOf("main").document().name()).toBe("Two");
});

test("a merge whose edits clash with a change on the target since the branch started is concurrent", async () => {
  const { a, b, edit, historyOf, alt } = await setUp();
  await edit(b, alt, [rename("Three")]);
  const quiet = await edit(a, "main", [
    { op: "branch.merge", branch: alt, through: historyOf(alt).head() },
  ]);
  expect(quiet.entered[0]?.concurrent).toBe(false);

  // The first merge's rename came from the branch, whose author saw it: no clash.
  await edit(b, alt, [rename("Four")]);
  const again = await edit(a, "main", [
    { op: "branch.merge", branch: alt, through: historyOf(alt).head() },
  ]);
  expect(again.entered[0]?.concurrent).toBe(false);

  await edit(a, "main", [rename("Main")]);
  await edit(b, alt, [rename("Five")]);
  const clashing = await edit(a, "main", [
    { op: "branch.merge", branch: alt, through: historyOf(alt).head() },
  ]);
  expect(clashing.entered[0]?.concurrent).toBe(true);
});

test("a closed branch takes no more entries, and main can't close", async () => {
  const { a, b, branches, edit, historyOf, alt } = await setUp();
  await edit(b, alt, [{ op: "branch.close", branch: alt }]);
  expect(branches.branches()[1]?.closed).toBe(true);
  await edit(b, alt, [rename("Late")]);
  expect(historyOf(alt).pending()).toHaveLength(1);
  expect(historyOf(alt).head().n).toBe(1);

  const { entered } = await edit(a, "main", [
    { op: "branch.close", branch: "main" },
    { op: "branch.merge", branch: "main", through: historyOf("main").head() },
  ]);
  expect(entered[0]?.skipped.map(({ reason }) => reason)).toEqual(["structural", "structural"]);
  expect(branches.branches()[0]?.closed).toBe(false);
});

test("a branch can be closed from another branch", async () => {
  const { a, branches, edit, alt } = await setUp();
  await edit(a, "main", [{ op: "branch.close", branch: alt }]);
  expect(branches.branches().map(({ closed }) => closed)).toEqual([false, true]);
});

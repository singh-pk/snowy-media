// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The comment budget of one edit (AGENTS.md rule 7), for tooling/lint-edited.ts. An agent copies
// the comment density of the code it reads, and a prose rule does not outweigh that, so each edit
// that adds more comment lines than its code warrants is handed back with those lines listed.

export interface Change {
  before: string;
  after: string;
}

// Lines another tool reads, which are never counted.
const MARKER = /^\s*(\/\/|\/\*|\*)\s*(SPDX-|copy:|readback:|oxlint-|jscpd:|@ts-)/;
const COMMENT = /^\s*(\/\/|\/\*|\*)/;
const SHARE = 0.15;
const FREE = 2;
const LONGEST = 3;

function count(text: string) {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const comments = lines.filter((l) => COMMENT.test(l) && !MARKER.test(l)).length;
  return { comments, code: lines.filter((l) => !COMMENT.test(l)).length };
}

// The comment blocks of `text` longer than LONGEST lines, by their first line.
function longBlocks(text: string) {
  const blocks: string[] = [];
  let run: string[] = [];

  for (const line of [...text.split("\n"), ""]) {
    if (COMMENT.test(line) && !MARKER.test(line)) {
      run.push(line.trim());
      continue;
    }

    if (run.length > LONGEST) blocks.push(run.join("\n"));
    run = [];
  }

  return blocks;
}

// What is wrong with the comments a change adds, or "" when they fit.
export function commentBudget(changes: Change[]) {
  let comments = 0;
  let code = 0;
  const added: string[] = [];

  for (const { before, after } of changes) {
    const [b, a] = [count(before), count(after)];
    comments += Math.max(0, a.comments - b.comments);
    // The code the edit covers, not only what it adds, so commenting existing code has a budget.
    code += a.code;
    const old = new Set(longBlocks(before));
    added.push(...longBlocks(after).filter((block) => !old.has(block)));
  }

  const budget = Math.max(FREE, Math.ceil(code * SHARE));
  const problems: string[] = [];

  if (comments > budget) {
    problems.push(
      `This edit adds ${comments} comment lines around ${code} lines of code; the budget is ${budget}.`,
    );
  }

  for (const block of added) {
    problems.push(`A new comment block runs past ${LONGEST} lines:\n${block}`);
  }

  if (problems.length === 0) return "";
  return `${problems.join("\n")}
Keep only a comment that says what the code can't: a reason that isn't obvious, an outside constraint, a performance choice, a trap, or an export's contract (units, edge values, what throws). Delete the rest, and say a kept reason in at most ${LONGEST} lines (AGENTS.md rule 7).`;
}

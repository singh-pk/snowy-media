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
// `/**`, ` */` or a bare `//`, which say nothing.
const DELIMITER = /^\s*(\/\*\*?|\*\/|\/\/)\s*$/;
const SHARE = 0.15;
const FREE = 2;
const LONGEST = 3;

const counted = (line: string) => COMMENT.test(line) && !MARKER.test(line) && !DELIMITER.test(line);

function count(text: string) {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  return {
    comments: lines.filter(counted).length,
    code: lines.filter((l) => !COMMENT.test(l)).length,
  };
}

// The `//` blocks of `text`, as their counted lines. A `/** */` block is an export's contract,
// which may run longer, so it isn't one.
function blocks(text: string) {
  const found: string[][] = [];
  let run: string[] = [];

  for (const line of [...text.split("\n"), ""]) {
    if (/^\s*\/\//.test(line) && !MARKER.test(line)) {
      if (counted(line)) run.push(line.trim());
      continue;
    }

    if (run.length > 0) found.push(run);
    run = [];
  }

  return found;
}

const shared = (a: string[], b: string[]) => a.some((line) => b.includes(line));

// The blocks of `after` past LONGEST lines that grew: neither in `before` nor rewritten from a
// block there at least as long, so trimming or fixing a long block passes.
function grown(before: string, after: string) {
  const old = blocks(before);

  return blocks(after).filter(
    (block) =>
      block.length > LONGEST &&
      !old.some((was) => was.length >= block.length && shared(was, block)),
  );
}

// What is wrong with the comments a change adds, or "" when they fit.
export function commentBudget(changes: Change[]) {
  let comments = 0;
  let code = 0;
  const long: string[][] = [];

  for (const { before, after } of changes) {
    const [b, a] = [count(before), count(after)];
    comments += Math.max(0, a.comments - b.comments);
    // The code the edit covers, not only what it adds, so commenting existing code has a budget.
    code += a.code;
    long.push(...grown(before, after));
  }

  const budget = Math.max(FREE, Math.ceil(code * SHARE));
  const problems: string[] = [];

  if (comments > budget) {
    problems.push(
      `This edit adds ${comments} comment lines around ${code} lines of code; the budget is ${budget}.`,
    );
  }

  for (const block of long) {
    problems.push(`A \`//\` comment block runs past ${LONGEST} lines:\n${block.join("\n")}`);
  }

  if (problems.length === 0) return "";
  return `${problems.join("\n")}
Keep only a comment that says what the code can't: a reason that isn't obvious, an outside constraint, a performance choice, a trap, or an export's contract (units, edge values, what throws) in its \`/** */\`. Delete the rest, and say a kept reason in at most ${LONGEST} lines (AGENTS.md rule 7).`;
}

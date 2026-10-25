// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

// A comment says what the code does and why, now: plans and history go in an issue, the
// package's docs or its changelog (AGENTS.md rule 8).

const PLAN =
  /\b(TODO|FIXME|XXX|HACK)\b|\b(for now|later PR|next PR|no longer needed|for the time being)\b/i;

export default {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      plan: 'A comment says what the code does now, not plans or history ("{{words}}"). Put those in an issue, docs or the changelog.',
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const found = PLAN.exec(comment.value);
          if (found)
            context.report({ loc: comment.loc, messageId: "plan", data: { words: found[0] } });
        }
      },
    };
  },
};

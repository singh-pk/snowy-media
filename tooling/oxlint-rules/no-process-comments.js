// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

// A comment describes the code as it is. The history of a change, the plan for the next one and
// the conversation that produced it belong in the commit, the pull request or an issue. The
// patterns are narrow on purpose: a comment may say "previously decoded" or cite "step 3" of a
// specification.

const PATTERNS = [
  [/\b(TODO|FIXME|XXX|HACK)\b/, "a to-do marker"],
  [/\b(for now|for the time being|later PR|next PR)\b/i, "a promise of later work"],
  [/\bno longer needed\b/i, "change history"],
  [/\btemporar(y|ily) (fix|workaround|hack|solution|measure)\b/i, "a promise of later work"],
  [/^\s*(Phase|Stage) \d+\b/, "a plan step"],
  [/\b(as requested|the user (asked|wants|said))\b/i, "conversation context"],
  [/(?<![./])\b(claude|chatgpt|copilot)\b(?![/-]|\.\w)/i, "conversation context"],
  [/\b(llm|ai agent|language model)\b/i, "conversation context"],
  [/\b([Ww]e|I) (changed|replaced|removed|added|no longer)\b/, "change history"],
  [/\b(was changed|the old (code|version|way))\b/i, "change history"],
  [/^\s*(new|old|changed|updated|fixed):/i, "change history"],
];

export default {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      processComment:
        "This comment holds {{kind}}. Say what the code does and why; history and plans go in the commit, the pull request or an issue (AGENTS.md rule 8).",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const match = PATTERNS.find(([pattern]) => pattern.test(comment.value));
          if (!match) continue;
          context.report({
            loc: comment.loc,
            messageId: "processComment",
            data: { kind: match[1] },
          });
        }
      },
    };
  },
};

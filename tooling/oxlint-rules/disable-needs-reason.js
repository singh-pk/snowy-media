// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

// An exception to a rule is as narrow as it can be and says why: one line, the rules it
// names, and a reason of a few words. A block or file-wide disable is reported here too, and
// by tooling/check-exceptions.ts, since one can switch this rule off with the rest.

const DIRECTIVE = /^\s*(oxlint|eslint)-disable(-next-line|-line)?(?=\s|$)/;
// The rules a directive names: what follows it, up to its reason.
const NAMED = /^\s*(oxlint|eslint)-disable(?:-next-line|-line)?\s+(?!--)\S/;
// At least three words after `--`.
const REASON = /\s--\s+\S+\s+\S+\s+\S/;

export default {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      noReason:
        "Say why the rule doesn't apply here, in a few words: end the directive with `-- <reason>`. Better still, change the code so it passes.",
      noRule: "Name the rules the directive turns off; one that names none turns off every rule.",
      block:
        "Turn a rule off for one line (`oxlint-disable-next-line <rule> -- <reason>`), not for a block or a file.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const { value } = comment;
          const directive = DIRECTIVE.exec(value);
          if (!directive) continue;
          const loc = comment.loc;
          if (!directive[2]) context.report({ loc, messageId: "block" });
          if (!NAMED.test(value)) context.report({ loc, messageId: "noRule" });
          if (!REASON.test(value)) context.report({ loc, messageId: "noReason" });
        }
      },
    };
  },
};

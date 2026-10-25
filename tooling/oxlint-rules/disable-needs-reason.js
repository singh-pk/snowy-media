// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

const DIRECTIVE = /^\s*(oxlint|eslint)-disable(-next-line|-line)?\b/;
const REASON = /\s--\s+\S/;

export default {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      noReason:
        "Say why the rule doesn't apply here: end the directive with `-- <reason>`. Better still, change the code so it passes.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const { value } = comment;
          if (!DIRECTIVE.test(value) || REASON.test(value)) continue;
          context.report({ loc: comment.loc, messageId: "noReason" });
        }
      },
    };
  },
};

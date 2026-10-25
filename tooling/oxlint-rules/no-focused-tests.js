// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

// A test that is skipped, focused or conditional passes without proving anything.

const RUNNERS = new Set(["test", "it", "describe"]);
const MODIFIERS = new Set(["only", "skip", "todo", "skipIf", "if", "failing", "fails"]);

export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      focused:
        "`{{runner}}.{{modifier}}` hides other tests or this one. Every test runs every time; fix or delete it instead.",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (node.computed || !RUNNERS.has(node.object.name)) return;
        if (!MODIFIERS.has(node.property.name)) return;
        context.report({
          node,
          messageId: "focused",
          data: { runner: node.object.name, modifier: node.property.name },
        });
      },
    };
  },
};

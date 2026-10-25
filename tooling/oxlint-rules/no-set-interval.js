// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

const INTERVAL_NAMES = new Set(["setInterval", "clearInterval"]);

function isObjectKey(node) {
  return node.parent?.type === "Property" && node.parent.key === node;
}

function isPropertyRead(node) {
  const parent = node.parent;
  const isProperty = parent?.type === "MemberExpression" && parent.property === node;
  if (!isProperty || parent.computed) return false;
  const call = parent.parent;
  return !(call?.type === "CallExpression" && call.callee === parent);
}

export default {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      interval: "Do not use setInterval. Wait on the event itself.",
    },
  },
  create(context) {
    return {
      Identifier(node) {
        if (!INTERVAL_NAMES.has(node.name)) return;
        if (isObjectKey(node) || isPropertyRead(node)) return;
        context.report({ node, messageId: "interval" });
      },
    };
  },
};

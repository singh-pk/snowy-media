// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

import { isObjectKey, isPropertyRead } from "./ast.js";

const INTERVAL_NAMES = new Set(["setInterval", "clearInterval"]);

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

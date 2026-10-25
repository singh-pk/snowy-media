// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

// Package code waits on events, never on time: no timer, and no wait with a time limit.

const TIMERS = new Set(["setTimeout", "requestIdleCallback"]);
const WAITS = new Set(["wait", "waitAsync"]);

// The name a member expression reads: `o.name` or `o["name"]`.
function propertyName(member) {
  if (!member.computed) return member.property.name;
  const { property } = member;
  return property.type === "Literal" && typeof property.value === "string" ? property.value : "";
}

function isObjectKey(node) {
  return node.parent?.type === "Property" && node.parent.key === node;
}

// `o.setTimeout` read as a property and not called, as an options object's field is.
function isPropertyRead(node) {
  const parent = node.parent;
  const isProperty = parent?.type === "MemberExpression" && parent.property === node;
  if (!isProperty || parent.computed) return false;
  const call = parent.parent;
  return !(call?.type === "CallExpression" && call.callee === parent);
}

// Whether `node` is `Atomics`, or `globalThis.Atomics` and the like.
function isAtomics(node) {
  if (node.type === "Identifier") return node.name === "Atomics";
  return node.type === "MemberExpression" && propertyName(node) === "Atomics";
}

// Whether the arguments of an Atomics wait give it a time limit: a fourth argument other than
// Infinity, or a spread that may hold one.
function isTimed(args) {
  if (args.some((a) => a.type === "SpreadElement")) return true;
  const limit = args[3];
  return limit !== undefined && !(limit.type === "Identifier" && limit.name === "Infinity");
}

export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      timer: "Do not use {{name}} in package code. Wait on the event that ends the wait.",
      timedWait:
        "Do not give Atomics.{{name}} a time limit in package code. Wait until the value changes.",
    },
  },
  create(context) {
    return {
      // Any use of a timer's name, called or passed on: `setTimeout`, `globalThis.setTimeout`,
      // `const { setTimeout } = globalThis`.
      Identifier(node) {
        if (!TIMERS.has(node.name) || isPropertyRead(node)) return;
        if (isObjectKey(node) && node.parent.parent?.type !== "ObjectPattern") return;
        context.report({ node, messageId: "timer", data: { name: node.name } });
      },
      MemberExpression(node) {
        const name = propertyName(node);

        if (node.computed && TIMERS.has(name)) {
          context.report({ node, messageId: "timer", data: { name } });
        }

        const isTimeout = name === "timeout" && node.object.type === "Identifier";

        if (isTimeout && node.object.name === "AbortSignal") {
          context.report({ node, messageId: "timer", data: { name: "AbortSignal.timeout" } });
        }
      },
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== "MemberExpression" || !isAtomics(callee.object)) return;
        const name = propertyName(callee);

        if (WAITS.has(name) && isTimed(node.arguments)) {
          context.report({ node, messageId: "timedWait", data: { name } });
        }
      },
    };
  },
};

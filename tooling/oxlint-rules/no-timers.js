// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

// Package code waits on events, never on time: no timer, and no wait with a time limit.
// requestIdleCallback is allowed, since it runs when the browser is idle rather than after a
// time, but not its `timeout` option, which turns it back into a delay; nor
// `scheduler.postTask` with a `delay`.

import { isObjectKey, isPropertyRead } from "./ast.js";

const TIMERS = new Set(["setTimeout"]);
const WAITS = new Set(["wait", "waitAsync"]);

// The name a member expression reads: `o.name` or `o["name"]`.
function propertyName(member) {
  if (!member.computed) return member.property.name;
  const { property } = member;
  return property.type === "Literal" && typeof property.value === "string" ? property.value : "";
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

// Whether an options argument may set `key`: a literal that names it or spreads another object,
// or any value the rule can't read, such as a variable.
function hasOption(options, key) {
  if (options === undefined) return false;
  if (options.type !== "ObjectExpression") return true;
  return options.properties.some(
    (p) => p.type === "SpreadElement" || (p.key.name ?? p.key.value) === key,
  );
}

// Whether `node` is called right where it is named, as `f()` or `o.f()`, so its options show.
function isCalledInPlace(node) {
  const member = node.parent?.type === "MemberExpression" && node.parent.property === node;
  const callee = member ? node.parent : node;
  return callee.parent?.type === "CallExpression" && callee.parent.callee === callee;
}

export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      timer: "Do not use {{name}} in package code. Wait on the event that ends the wait.",
      idleTimeout:
        "Do not give requestIdleCallback a `timeout` in package code: it forces the work after a delay. Wait on the event that makes it urgent.",
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
      // requestIdleCallback renamed or handed on, whose options the rule can no longer see.
      "Identifier[name='requestIdleCallback']"(node) {
        if (isCalledInPlace(node)) return;
        if (isObjectKey(node) && node.parent.parent?.type !== "ObjectPattern") return;
        context.report({ node, messageId: "idleTimeout" });
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
        const isMember = callee.type === "MemberExpression";
        const name = isMember ? propertyName(callee) : callee.name;
        const options = node.arguments[1];

        if (name === "requestIdleCallback" && hasOption(options, "timeout")) {
          context.report({ node, messageId: "idleTimeout" });
        }

        if (name === "postTask" && hasOption(options, "delay")) {
          context.report({
            node,
            messageId: "timer",
            data: { name: "scheduler.postTask with a delay" },
          });
        }

        const isWait = isMember && isAtomics(callee.object) && WAITS.has(name);
        if (isWait && isTimed(node.arguments))
          context.report({ node, messageId: "timedWait", data: { name } });
      },
    };
  },
};

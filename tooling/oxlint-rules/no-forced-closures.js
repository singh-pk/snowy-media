// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

// A closure is made once, where its state lives: in a `createX()` factory, or as a named inner
// function. An IIFE builds a scope only to run once. A function made on every turn of a loop
// that uses nothing from that turn is the same closure rebuilt each time, and belongs outside
// the loop. A function that closes over the turn's own bindings is allowed, as is one handed to
// a call, however it is wrapped (an options object, an array, a cast, `??` or `?:`): it is the
// call's argument, not state kept. So is one returned or thrown, which is built at most once.

import { isFunction } from "./ast.js";

const LOOPS = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
]);

// Expressions that pass a value on unchanged, as far as where it ends up is concerned.
const WRAPPERS = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "ConditionalExpression",
  "LogicalExpression",
  "ArrayExpression",
  "ObjectExpression",
  "Property",
  "SpreadElement",
]);
const ONCE = new Set(["ReturnStatement", "ThrowStatement"]);

function isCast(node) {
  return node.type === "ParenthesizedExpression" || node.type.startsWith("TS");
}

function unwrap(node) {
  let inner = node;
  while (isCast(inner) && inner.expression) inner = inner.expression;
  return inner;
}

// The function an IIFE runs: `(() => …)()`, or `(function () { … }).call(…)` and `.apply`.
function invoked(callee) {
  const inner = unwrap(callee);
  if (isFunction(inner)) return inner;
  const isCallOrApply =
    inner.type === "MemberExpression" && ["call", "apply"].includes(inner.property.name);
  return isCallOrApply && isFunction(unwrap(inner.object)) ? inner : undefined;
}

// Whether `node` reaches a call's arguments, or a `return` or `throw`, through wrappers only.
function isPassedOn(node) {
  let child = node;

  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ONCE.has(parent.type)) return true;
    const isCall = parent.type === "CallExpression" || parent.type === "NewExpression";
    if (isCall) return parent.arguments.includes(child);
    if (!WRAPPERS.has(parent.type)) return false;
    if (parent.type === "ConditionalExpression" && parent.test === child) return false;
    if (parent.type === "Property" && parent.value !== child) return false;
  }

  return false;
}

function contains(outer, node) {
  return outer.range[0] <= node.range[0] && node.range[1] <= outer.range[1];
}

// The innermost loop, head included, that remakes `node` on each turn, in the function holding it.
function enclosingLoop(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (isFunction(parent)) return undefined;
    if (LOOPS.has(parent.type) && contains(parent, node)) return parent;
  }

  return undefined;
}

export default {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      iife: "An IIFE builds a scope to run once. Write a named function and call it, or keep the state in a createX() factory.",
      loop: "This closure uses nothing from the loop's turn, yet is rebuilt on each one. Declare it once, before the loop.",
    },
  },
  create(context) {
    // Whether the function reads or writes a binding declared inside `loop`, including the
    // loop's own head (`for (const x of xs)`).
    function usesTurn(node, loop) {
      const scope = context.sourceCode.scopeManager.acquire(node);
      const outer = scope?.through ?? [];
      return outer.some((ref) => {
        const declared = ref.resolved?.defs[0]?.node;
        // A recursive function's own name is not the turn's.
        const isSelf = declared === node || declared?.init === node;
        return declared !== undefined && !isSelf && contains(loop, declared);
      });
    }

    function checkFunction(node) {
      if (isPassedOn(node)) return;
      const loop = enclosingLoop(node);
      if (loop && !usesTurn(node, loop)) context.report({ node, messageId: "loop" });
    }

    return {
      CallExpression(node) {
        if (invoked(node.callee)) context.report({ node, messageId: "iife" });
      },
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
      FunctionDeclaration: checkFunction,
    };
  },
};

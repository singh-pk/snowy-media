// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

// An assertion that runs only on some paths lets the test pass on the others. Assert the value
// the branch depends on instead, or use `.rejects` and `toThrow` for errors. An `if` is fine when
// every path through it asserts: it has an `else` that asserts too, or it ends in `continue`,
// `break` or `return` and the statements after it assert. A guard that jumps past every
// assertion, as `if (!r.ok) return;` before the first `expect`, is reported too. A loop that runs
// no times, or a callback an empty collection never calls, is left to review.

const CONDITIONAL = new Set(["CatchClause", "ConditionalExpression", "SwitchCase"]);
const JUMPS = new Set(["ContinueStatement", "BreakStatement", "ReturnStatement"]);

function isFunction(node) {
  return node.type.endsWith("FunctionExpression") || node.type === "FunctionDeclaration";
}

function isTestBody(node) {
  return node.parent?.type === "CallExpression" && node.parent.callee.name === "test";
}

// A nested function runs on the enclosing path when it is handed straight to a call, as `map`,
// `forEach` or `new Promise` take it.
function mayRun(node) {
  const call = node.parent;
  const isCall = call?.type === "CallExpression" || call?.type === "NewExpression";
  return isCall && call.arguments.includes(node);
}

function children(node) {
  const out = [];

  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = node[key];
    if (Array.isArray(value)) out.push(...value.filter((v) => typeof v?.type === "string"));
    else if (typeof value?.type === "string") out.push(value);
  }

  return out;
}

// Whether `node` calls `expect`, outside any function nested in it.
function asserts(node) {
  if (!node) return false;
  const stack = [node];

  while (stack.length > 0) {
    const next = stack.pop();
    if (next !== node && isFunction(next) && !mayRun(next)) continue;
    if (next.type === "CallExpression" && next.callee.name === "expect") return true;
    stack.push(...children(next));
  }

  return false;
}

function endsInJump(statement) {
  const last = statement.type === "BlockStatement" ? statement.body.at(-1) : statement;
  return last !== undefined && JUMPS.has(last.type);
}

// Whether the statements after `statement` in its block assert.
function assertsAfter(statement) {
  const body = statement.parent?.body;
  if (!Array.isArray(body)) return false;
  return body.slice(body.indexOf(statement) + 1).some(asserts);
}

// Whether every path through the `if` asserts, given that `branch` does.
function isCovered(ifStatement, branch) {
  if (branch === ifStatement.alternate) return asserts(ifStatement.consequent);
  if (ifStatement.alternate) return asserts(ifStatement.alternate);
  return endsInJump(branch) && assertsAfter(ifStatement);
}

// Whether `child` sits on a path its `parent` may not take: a branch, not the condition itself.
function isBranch(parent, child) {
  if (parent.type === "LogicalExpression") return parent.right === child;
  if (parent.type === "ChainExpression") return true;
  if (parent.type === "TryStatement") return parent.block === child && parent.handler !== null;
  if (parent.type === "IfStatement") return parent.test !== child && !isCovered(parent, child);
  if (!CONDITIONAL.has(parent.type)) return false;
  return parent.type === "CatchClause" || parent.test !== child;
}

function isConditional(node) {
  let child = node;

  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (isFunction(parent)) return isTestBody(parent) ? false : isConditional(parent);
    if (isBranch(parent, child)) return true;
  }

  return false;
}

// Whether `node` runs as part of a test body, directly or in a callback the body hands on.
function isInTest(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!isFunction(parent)) continue;
    if (isTestBody(parent)) return true;
    if (!mayRun(parent)) return false;
  }

  return false;
}

// Whether the `if` jumps out before any assertion on one path and asserts after on the other.
function isGuardPastAssertions(ifStatement) {
  const jumps = [ifStatement.consequent, ifStatement.alternate].filter((b) => b && endsInJump(b));
  if (jumps.length === 0 || jumps.some(asserts)) return false;
  const body = ifStatement.parent?.body;
  if (!Array.isArray(body)) return false;
  const at = body.indexOf(ifStatement);
  return !body.slice(0, at).some(asserts) && assertsAfter(ifStatement) && isInTest(ifStatement);
}

export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      guard:
        "This guard jumps past every expect, so the test passes whenever it is taken. Assert the condition, or throw on it.",
      conditional:
        "This expect runs only on some paths, so the test passes on the others. Assert the value the branch depends on, or use `.rejects`/`toThrow`.",
    },
  },
  create(context) {
    return {
      "CallExpression[callee.name='expect']"(node) {
        if (isConditional(node)) context.report({ node, messageId: "conditional" });
      },
      IfStatement(node) {
        if (isGuardPastAssertions(node)) context.report({ node, messageId: "guard" });
      },
    };
  },
};

// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

// An assertion that runs only on some paths lets the test pass on the others. Assert the value
// the branch depends on instead, or use `.rejects` and `toThrow` for errors. An `if` is fine when
// every path through it asserts: it has an `else` that asserts too, or it ends in `continue`,
// `break` or `return` and the statements after it assert. A loop that runs no times is left to
// review.

const CONDITIONAL = new Set(["CatchClause", "ConditionalExpression", "SwitchCase"]);
const JUMPS = new Set(["ContinueStatement", "BreakStatement", "ReturnStatement"]);

function isFunction(node) {
  return node.type.endsWith("FunctionExpression") || node.type === "FunctionDeclaration";
}

function isTestBody(node) {
  return node.parent?.type === "CallExpression" && node.parent.callee.name === "test";
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
    if (next !== node && isFunction(next)) continue;
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

export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      conditional:
        "This expect runs only on some paths, so the test passes on the others. Assert the value the branch depends on, or use `.rejects`/`toThrow`.",
    },
  },
  create(context) {
    return {
      "CallExpression[callee.name='expect']"(node) {
        if (isConditional(node)) context.report({ node, messageId: "conditional" });
      },
    };
  },
};

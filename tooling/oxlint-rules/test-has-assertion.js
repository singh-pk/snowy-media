// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

// A test that asserts nothing passes whatever the code does. A test asserts when its body calls
// `expect` or `assert`, or calls a function declared in the same file that does. A function the
// body only defines, without passing it to a call, does not count, since it may never run.
// Helpers imported from another file are not followed: assert in the test, or declare the
// helper beside it.

function isFunction(node) {
  return node.type.endsWith("FunctionExpression") || node.type === "FunctionDeclaration";
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

function rootName(callee) {
  let node = callee;

  while (node.type === "MemberExpression" || node.type === "CallExpression") {
    node = node.type === "MemberExpression" ? node.object : node.callee;
  }

  return node.type === "Identifier" ? node.name : undefined;
}

// A nested function runs only when it is handed straight to a call, as `map` or `forEach` take it.
function mayRun(node) {
  return node.parent?.type === "CallExpression" && node.parent.arguments.includes(node);
}

function calledNames(body) {
  const names = new Set();
  const stack = [body];

  while (stack.length > 0) {
    const node = stack.pop();
    if (node !== body && isFunction(node) && !mayRun(node)) continue;
    const name = node.type === "CallExpression" ? rootName(node.callee) : undefined;
    if (name) names.add(name);
    stack.push(...children(node));
  }

  return names;
}

function declaredFunction(node) {
  if (node.type === "FunctionDeclaration" && node.id) return [node.id.name, node.body];
  const isNamedFunction = node.type === "VariableDeclarator" && node.id.type === "Identifier";
  if (isNamedFunction && node.init && isFunction(node.init)) return [node.id.name, node.init.body];
  return undefined;
}

// Every function the file declares by name, in any scope.
function localFunctions(program) {
  const functions = [];
  const stack = [program];

  while (stack.length > 0) {
    const node = stack.pop();
    const declared = declaredFunction(node);
    if (declared) functions.push(declared);
    stack.push(...children(node));
  }

  return functions;
}

// The local functions that assert, directly or through one another.
function assertingFunctions(program) {
  const calls = localFunctions(program).map(([name, body]) => [name, [...calledNames(body)]]);
  const asserting = new Set(["expect", "assert"]);
  let grew = true;

  while (grew) {
    const found = calls.filter(
      ([n, names]) => !asserting.has(n) && names.some((c) => asserting.has(c)),
    );
    for (const [name] of found) asserting.add(name);
    grew = found.length > 0;
  }

  return asserting;
}

export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      noAssertion:
        "This test asserts nothing, so it passes whatever the code does. Expect the result it is named for.",
    },
  },
  create(context) {
    let asserting = new Set();

    return {
      Program(node) {
        asserting = assertingFunctions(node);
      },
      "CallExpression[callee.name='test']"(node) {
        const body = node.arguments.find(isFunction);
        if (!body || [...calledNames(body.body)].some((n) => asserting.has(n))) return;
        context.report({ node: node.arguments[0] ?? node, messageId: "noAssertion" });
      },
    };
  },
};

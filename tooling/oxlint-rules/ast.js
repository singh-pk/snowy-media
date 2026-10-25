// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

// Questions about syntax tree nodes that several rules ask.

export function isFunction(node) {
  return node.type.endsWith("FunctionExpression") || node.type === "FunctionDeclaration";
}

// A nested function runs on the enclosing path when it is handed straight to a call, as `map`,
// `forEach` or `new Promise` take it.
export function mayRun(node) {
  const call = node.parent;
  const isCall = call?.type === "CallExpression" || call?.type === "NewExpression";
  return isCall && call.arguments.includes(node);
}

// The nodes directly below `node`.
export function children(node) {
  const out = [];

  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = node[key];
    if (Array.isArray(value)) out.push(...value.filter((v) => typeof v?.type === "string"));
    else if (typeof value?.type === "string") out.push(value);
  }

  return out;
}

// `name` as the key of an object literal's property or of a destructuring pattern.
export function isObjectKey(node) {
  return node.parent?.type === "Property" && node.parent.key === node;
}

// `o.name` read as a property and not called, as an options object's field is.
export function isPropertyRead(node) {
  const parent = node.parent;
  const isProperty = parent?.type === "MemberExpression" && parent.property === node;
  if (!isProperty || parent.computed) return false;
  const call = parent.parent;
  return !(call?.type === "CallExpression" && call.callee === parent);
}

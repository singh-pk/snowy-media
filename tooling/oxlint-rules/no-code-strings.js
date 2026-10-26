// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

// Code runs only from modules, never from a string: the ways around `no-eval` and
// `no-new-func`. A function's `constructor` is `Function` by another name, as is
// `globalThis.Function`, and a `data:` or `blob:` URL, or one made from a Blob, turns a string
// into a module, a worker or a worklet.

const GLOBALS = new Set(["globalThis", "window", "self"]);

// The name a member expression reads: `o.name`, `o["name"]` or `o[`name`]`.
function propertyName(member) {
  if (!member.computed) return member.property.name;
  const { property } = member;
  if (property.type === "Literal") return typeof property.value === "string" ? property.value : "";
  return property.type === "TemplateLiteral" && property.expressions.length === 0
    ? (property.quasis[0]?.value.cooked ?? "")
    : "";
}

// The text a string starts with: a literal, a template's first part, or the left of a `+`.
function leadingText(node) {
  if (node?.type === "Literal") return typeof node.value === "string" ? node.value : "";
  if (node?.type === "TemplateLiteral") return node.quasis[0]?.value.cooked ?? "";
  return node?.type === "BinaryExpression" && node.operator === "+" ? leadingText(node.left) : "";
}

// Whether `node` is `URL.createObjectURL(…)`.
function isObjectUrl(node) {
  const callee = node?.type === "CallExpression" ? node.callee : undefined;
  return callee?.type === "MemberExpression" && propertyName(callee) === "createObjectURL";
}

// A `data:` or `blob:` URL, which the URL parser reads past leading spaces, or an object URL.
const fromString = (node) => /^\s*(data|blob):/i.test(leadingText(node)) || isObjectUrl(node);

// Whether a `constructor` read is safe: its `.name` and the like, a comparison, or a call or
// `new` with only numbers, as `new array.constructor(4)` makes a typed array.
function isSafeConstructor(node) {
  const { parent } = node;

  if (parent.type === "MemberExpression" && parent.object === node) {
    return !["call", "apply", "bind"].includes(propertyName(parent));
  }

  if (
    (parent.type === "CallExpression" || parent.type === "NewExpression") &&
    parent.callee === node
  ) {
    const numbers = parent.arguments.every(
      (a) => a.type === "Literal" && typeof a.value === "number",
    );
    return parent.arguments.length > 0 && numbers;
  }

  return parent.type === "BinaryExpression";
}

export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      constructor:
        "Do not use a function's `constructor` or `globalThis.Function`: it is `Function`, which runs a string as code.",
      url: "Do not run code from a `data:`, `blob:` or object URL. Import a module, or start a worker from its file.",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        const name = propertyName(node);
        if (name === "constructor" && !isSafeConstructor(node))
          context.report({ node, messageId: "constructor" });
        const isGlobal = node.object.type === "Identifier" && GLOBALS.has(node.object.name);
        if (isGlobal && name === "Function") context.report({ node, messageId: "constructor" });
      },
      // `Function` handed on or renamed, as `Reflect.construct(Function, …)` or
      // `const F = Function`, which `no-new-func`, reporting its calls, does not follow.
      "Identifier[name='Function']"(node) {
        const { parent } = node;
        const isCalled =
          (parent.type === "CallExpression" || parent.type === "NewExpression") &&
          parent.callee === node;
        const isCheck = parent.type === "BinaryExpression" && parent.operator === "instanceof";
        if (isCalled || isCheck || parent.type.startsWith("TS")) return;
        if (parent.type === "MemberExpression" && parent.property === node && !parent.computed)
          return;
        if (
          parent.type === "Property" &&
          parent.key === node &&
          parent.parent?.type !== "ObjectPattern"
        )
          return;
        context.report({ node, messageId: "constructor" });
      },
      // `const { constructor: F } = f`.
      Property(node) {
        const isTaken =
          node.parent?.type === "ObjectPattern" &&
          propertyName({ computed: node.computed, property: node.key }) === "constructor";
        if (isTaken) context.report({ node, messageId: "constructor" });
      },
      NewExpression(node) {
        const { callee } = node;
        const name = callee.type === "MemberExpression" ? propertyName(callee) : callee.name;
        const isWorker = /^(Shared)?Worker$/.test(name ?? "");
        if (isWorker && fromString(node.arguments[0])) context.report({ node, messageId: "url" });
      },
      // A worklet's module: `audioWorklet.addModule(url)`; and `Reflect.get(f, "constructor")`.
      CallExpression(node) {
        const { callee } = node;
        const isGet =
          callee.type === "MemberExpression" &&
          propertyName(callee) === "get" &&
          callee.object.name === "Reflect";
        const key = leadingText(node.arguments[1]);
        if (isGet && (key === "constructor" || key === "Function"))
          context.report({ node, messageId: "constructor" });
        const isAdd = callee.type === "MemberExpression" && propertyName(callee) === "addModule";
        if (isAdd && fromString(node.arguments[0])) context.report({ node, messageId: "url" });
      },
      ImportExpression(node) {
        if (fromString(node.source)) context.report({ node, messageId: "url" });
      },
    };
  },
};

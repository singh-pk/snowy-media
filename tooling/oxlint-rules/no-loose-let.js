// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

// A `let` is state that changes, kept as close to its use as it can be:
// - never at module level, where it is a mutable singleton (keep it in a createX() factory);
// - never declared without a value only to be set inside a `try` whose `catch` throws, or that
//   has none: `let json; try { json = … } catch { throw … }` is a `const` from a small function
//   that returns inside the `try`. A `catch` that returns or continues instead, which a helper
//   can't do for its caller, is allowed, as is a `let` the `catch` or `finally` reads to clean
//   up, or one set in a loop, in a callback, or across the branches of an `if` outside the `try`;
// - when its value has no side effects (a literal, a name, `[]` or `{}`), never in a wider block
//   than every read and write of it, unless a loop or function between them needs it to outlive
//   one turn or call. A value that runs code, such as `performance.now()`, may be read where it
//   is declared on purpose, so it is left to review, as is a `let` declared with no value.

const LOOPS = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
]);

const BLOCKS = new Set(["BlockStatement", "StaticBlock", "Program", "SwitchCase"]);

function isFunction(node) {
  return node.type.endsWith("FunctionExpression") || node.type === "FunctionDeclaration";
}

function contains(outer, node) {
  return (
    outer !== null &&
    outer !== undefined &&
    outer.range[0] <= node.range[0] &&
    node.range[1] <= outer.range[1]
  );
}

function ancestors(node) {
  const out = [];
  for (let parent = node.parent; parent; parent = parent.parent) out.push(parent);
  return out;
}

// The innermost block holding every one of `nodes`.
function commonBlock(nodes) {
  const [first, ...rest] = nodes.map((n) => ancestors(n).filter((a) => BLOCKS.has(a.type)));
  return first?.find((block) => rest.every((chain) => chain.includes(block)));
}

// Whether a loop or function lies between `inner` and `outer`, so moving the `let` in would
// change how long it lives.
function crossesLifetime(inner, outer) {
  for (let node = inner; node && node !== outer; node = node.parent) {
    if (LOOPS.has(node.type) || isFunction(node)) return true;
  }

  return false;
}

// The try statement whose block holds `node`, below `stop`.
function enclosingTry(node, stop) {
  let child = node;

  for (let parent = node.parent; parent && parent !== stop; parent = parent.parent) {
    if (parent.type === "TryStatement" && parent.block === child) return parent;
    child = parent;
  }

  return undefined;
}

// Whether every write sets the value inside a try whose catch and finally never read it.
function isSetInTry(writes, uses, stop) {
  const tries = writes.map((w) => enclosingTry(w.identifier, stop));
  if (tries.length === 0 || tries.includes(undefined) || !tries.every(catchThrows)) return false;
  const cleansUp = (t) => uses.some((u) => contains(t.handler, u) || contains(t.finalizer, u));
  return !tries.some(cleansUp);
}

// Whether a value can be computed later, where it is used, without changing what it holds.
function isPure(init) {
  if (init.type === "Literal" || init.type === "Identifier") return true;
  if (init.type === "TemplateLiteral") return init.expressions.length === 0;
  if (init.type === "UnaryExpression") return init.argument.type === "Literal";
  if (init.type === "ArrayExpression") return init.elements.length === 0;
  return init.type === "ObjectExpression" && init.properties.length === 0;
}

// Whether the try has no catch, or one that always ends by throwing.
function catchThrows(tryStatement) {
  const body = tryStatement.handler?.body.body;
  return body === undefined || body.at(-1)?.type === "ThrowStatement";
}

function isModuleLevel(node) {
  const { parent } = node;
  if (parent.type === "Program") return true;
  return parent.type === "ExportNamedDeclaration" && parent.parent.type === "Program";
}

export default {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      moduleLet:
        "Module-level `let` is a mutable singleton. Hold the state inside a factory (createX) and return it, or make the binding `const`.",
      setInTry:
        "`{{name}}` is declared only to be set inside a `try`. Make it a `const` from a small function that returns inside the `try`.",
      wideScope: "`{{name}}` is used only inside a narrower block. Declare it there.",
    },
  },
  create(context) {
    function checkVariable(variable, node) {
      const declarator = variable.defs[0]?.node;
      if (!declarator) return;
      const data = { name: variable.name };
      const isOwn = (r) => r.identifier !== declarator.id;
      const writes = variable.references.filter((r) => r.isWrite() && isOwn(r));
      const uses = variable.references.filter(isOwn).map((r) => r.identifier);

      if (declarator.init === null || declarator.init === undefined) {
        const isStraightLine = writes.every((w) => !crossesLifetime(w.identifier, node.parent));
        const report = isStraightLine && isSetInTry(writes, uses, node.parent);
        if (report) context.report({ node: declarator, messageId: "setInTry", data });
        return;
      }

      if (!isPure(declarator.init)) return;
      const block = commonBlock(uses);
      const isNarrower = block && block !== node.parent && !crossesLifetime(block, node.parent);
      if (isNarrower) context.report({ node: declarator, messageId: "wideScope", data });
    }

    function check(node) {
      if (isModuleLevel(node)) {
        context.report({ node, messageId: "moduleLet" });
        return;
      }

      if (LOOPS.has(node.parent.type)) return;
      for (const variable of context.sourceCode.getDeclaredVariables(node))
        checkVariable(variable, node);
    }

    return { "VariableDeclaration[kind='let']": check };
  },
};

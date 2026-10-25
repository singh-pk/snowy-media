// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

// Every copy is on purpose. A copy of a collection, or a read back from the GPU or a frame, says
// why in a `// copy: …` or `// readback: …` comment: one on its own lines, which covers the
// statement right below it (a property of an object literal counts as its own statement), or
// one at the end of the copy's own line, which covers that line only. The rule reports:
// - a spread that builds an array or an object, or fills a call's arguments. Spreading a literal,
//   as in `...(on ? { on } : {})` for an optional field, copies nothing, and forwarding a rest
//   parameter passes it on, so neither is reported;
// - `Array.from(x)` without a map function (with one, or from `{ length }`, it builds new data),
//   and `.toArray()` straight off a collection (after `map` or `filter`, it builds new data);
// - `.slice(…)`, `.concat(…)`, `toSorted`, `toReversed`, `toSpliced`, `.with(…)`,
//   `structuredClone` and `Object.assign({}, …)`;
// - `mapAsync`, `copyTextureToBuffer` and `.copyTo(…)`, which bring a GPU buffer or a frame's
//   planes back to the CPU.
// Without types, `slice` is reported on a string or a Blob too: a string takes `substring`. Left
// to review: a typed array built from another (`new Uint8Array(view)` copies, from an
// ArrayBuffer it doesn't), `new Map(m)` and `new Set(s)`, `Object.assign` into an object that
// already exists, and what a `postMessage` clones.

const COPIES = new Set(["slice", "concat", "toSorted", "toReversed", "toSpliced", "with"]);
const READBACKS = new Set(["mapAsync", "copyTextureToBuffer", "copyTo"]);
const BUILDERS = new Set(["map", "filter", "flatMap", "take", "drop"]);
const REASON = /^\s*(copy|readback):\s*\S/;

function isFunction(node) {
  return node.type.endsWith("FunctionExpression") || node.type === "FunctionDeclaration";
}

function methodName(callee) {
  return callee.type === "MemberExpression" && !callee.computed ? callee.property.name : undefined;
}

function isStatement(node) {
  return node.type.endsWith("Statement") || node.type.endsWith("Declaration");
}

// The first line of the statement holding `node`, or of the property it is in.
function statementLine(node) {
  for (let parent = node; parent; parent = parent.parent) {
    if (isStatement(parent) || parent.type === "Property") return parent.loc.start.line;
  }

  return node.loc.start.line;
}

// Whether `node` is a literal made right there, or a choice between such literals.
function isLiteral(node) {
  const { type } = node;
  if (type === "ObjectExpression" || type === "ArrayExpression") return true;
  if (type === "ParenthesizedExpression") return isLiteral(node.expression);
  if (type === "ConditionalExpression")
    return isLiteral(node.consequent) && isLiteral(node.alternate);
  if (type !== "LogicalExpression") return false;
  // `on && { on }` spreads its right side or nothing; `??` and `||` may spread their left.
  return isLiteral(node.right) && (node.operator === "&&" || isLiteral(node.left));
}

// Whether `spread` passes on a rest parameter, of the function it is in or one around it.
function isForwardedRest(spread) {
  if (spread.argument.type !== "Identifier") return false;
  const { name } = spread.argument;

  for (let parent = spread.parent; parent; parent = parent.parent) {
    if (!isFunction(parent)) continue;
    const rest = parent.params.at(-1);
    if (rest?.type === "RestElement" && rest.argument.name === name) return true;
  }

  return false;
}

// What `call` copies or reads back, if anything.
function copyOf(call) {
  const { callee } = call;
  const method = methodName(callee);
  const [first, second] = call.arguments;
  const object = callee.object;
  const onObject = (name) => object?.type === "Identifier" && object.name === name;
  const isClone =
    callee.name === "structuredClone" || (method === "structuredClone" && onObject("globalThis"));
  if (isClone) return "copy";
  if (READBACKS.has(method)) return "readback";
  if (COPIES.has(method)) return "copy";

  if (method === "from" && onObject("Array")) {
    const isLength = first?.type === "ObjectExpression";
    return second === undefined && !isLength ? "copy" : undefined;
  }

  if (method === "assign" && onObject("Object")) {
    const isEmpty = first?.type === "ObjectExpression" && first.properties.length === 0;
    return isEmpty ? "copy" : undefined;
  }

  if (method === "toArray") {
    const built = object?.type === "CallExpression" && BUILDERS.has(methodName(object.callee));
    return built ? undefined : "copy";
  }

  return undefined;
}

export default {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      copy: "This copies {{what}}. Avoid the copy, or say why it is needed in a `// copy:` comment above the statement or at the end of the line.",
      readback:
        "This reads data back to the CPU. Avoid it, or say why it is needed in a `// readback:` comment above the statement or at the end of the line.",
    },
  },
  create(context) {
    const { text } = context.sourceCode;

    // Whether code comes before `comment` on its line.
    function isTrailing(comment) {
      const lineStart = text.lastIndexOf("\n", comment.range[0] - 1) + 1;
      return text.slice(lineStart, comment.range[0]).trim() !== "";
    }

    // The lines a reason covers: a trailing one's own line; for one on its own lines, the line
    // after the run of comment lines it starts.
    const covered = new Set();
    let reasoned = false;
    let lastLine = -1;

    for (const comment of context.sourceCode.getAllComments()) {
      if (isTrailing(comment)) {
        if (REASON.test(comment.value)) covered.add(comment.loc.start.line);
        reasoned = false;
        continue;
      }

      const continues = reasoned && comment.loc.start.line === lastLine + 1;
      reasoned = continues || REASON.test(comment.value);
      lastLine = comment.loc.end.line;
      if (reasoned) covered.add(comment.loc.end.line + 1);
    }

    function isReasoned(node) {
      return covered.has(node.loc.start.line) || covered.has(statementLine(node));
    }

    function report(node, messageId, what) {
      if (!isReasoned(node)) context.report({ node, messageId, data: { what } });
    }

    return {
      SpreadElement(node) {
        const { parent } = node;
        if (isLiteral(node.argument)) return;
        if (parent.type === "ArrayExpression") report(node, "copy", "into a new array");
        if (parent.type === "ObjectExpression") report(node, "copy", "into a new object");
        const isCall = parent.type === "CallExpression" || parent.type === "NewExpression";
        if (isCall && !isForwardedRest(node)) report(node, "copy", "into the call's arguments");
      },
      CallExpression(node) {
        const kind = copyOf(node);
        if (kind === "readback") report(node, "readback", "");
        if (kind === "copy") report(node, "copy", "a collection");
      },
    };
  },
};

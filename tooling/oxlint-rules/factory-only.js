// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

// State lives in a `createX()` factory: a function that keeps its state in local bindings and
// returns an object of closures over them. Nothing reaches state through `this`, a constructor
// function or a prototype. The rule reports:
// - `this` outside a class method. The one place for it is a class the platform makes us extend
//   (an AudioWorkletProcessor, an Error), which `no-classes` allows;
// - `new` on a function this file declares, in any scope;
// - a prototype of such a function written or filled in: `F.prototype.x = …`,
//   `Object.assign(F.prototype, …)`, `Object.defineProperty(F.prototype, …)`. A test may still
//   stub a platform prototype, such as `AudioContext.prototype.resume`;
// - a prototype set by hand: `Object.create(proto)`, `Object.setPrototypeOf`,
//   `Reflect.setPrototypeOf` and `__proto__` in an object literal. `Object.create(null)`, a
//   dictionary with no prototype, is allowed.
// A function reached through a cast, or a name built at run time, is left to review.

const FILLS = new Set(["assign", "defineProperty", "defineProperties"]);

function isFunction(node) {
  return node.type.endsWith("FunctionExpression") || node.type === "FunctionDeclaration";
}

function isInClass(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "ClassBody") return true;
    // An arrow function has no `this` of its own; any other function that isn't a method does.
    const hasOwnThis =
      parent.type === "FunctionExpression" || parent.type === "FunctionDeclaration";
    if (hasOwnThis && parent.parent?.type !== "MethodDefinition") return false;
  }

  return false;
}

// The name a member expression reads: `o.name` or `o["name"]`.
function propertyName(member) {
  if (!member.computed) return member.property.name;
  const { property } = member;
  return property.type === "Literal" && typeof property.value === "string" ? property.value : "";
}

// The identifier whose prototype `node` names, as `F` in `F.prototype`.
function prototypeOwner(node) {
  if (node?.type !== "MemberExpression" || propertyName(node) !== "prototype") return undefined;
  return node.object.type === "Identifier" ? node.object : undefined;
}

function isObjectCall(node, names) {
  const { callee } = node;
  if (callee.type !== "MemberExpression" || callee.object.type !== "Identifier") return false;
  return callee.object.name === "Object" && names.has(propertyName(callee));
}

export default {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      thisOutsideClass:
        "`this` reaches state the reader can't see. Keep the state in a createX() factory's bindings and close over them.",
      constructorFunction:
        "`new {{name}}` uses a function as a constructor. Make it a createX() factory that returns an object, and call it without `new`.",
      prototype:
        "Prototypes hide where behaviour comes from. Return an object of closures from a createX() factory.",
    },
  },
  create(context) {
    // Whether `identifier` names a function declared in this file, in any scope.
    function isLocalFunction(identifier) {
      if (identifier?.type !== "Identifier") return false;

      for (let node = identifier.parent; node; node = node.parent) {
        const scope = context.sourceCode.scopeManager.acquire(node, true);
        const reference = scope?.references.find((r) => r.identifier === identifier);
        if (!reference) continue;
        // A parameter's definition also points at its function, so the kind is checked too.
        const def = reference.resolved?.defs[0];
        if (def?.type === "FunctionName") return true;
        const init = def?.type === "Variable" ? def.node.init : undefined;
        return !!init && isFunction(init);
      }

      return false;
    }

    function reportPrototype(node) {
      context.report({ node, messageId: "prototype" });
    }

    return {
      ThisExpression(node) {
        if (!isInClass(node)) context.report({ node, messageId: "thisOutsideClass" });
      },
      NewExpression(node) {
        if (!isLocalFunction(node.callee)) return;
        const data = { name: node.callee.name };
        context.report({ node, messageId: "constructorFunction", data });
      },
      AssignmentExpression(node) {
        const target = node.left;
        if (target.type !== "MemberExpression") return;
        const owner = prototypeOwner(target) ?? prototypeOwner(target.object);
        if (isLocalFunction(owner)) reportPrototype(node);
      },
      CallExpression(node) {
        const [first] = node.arguments;
        const isNullCreate = first?.type === "Literal" && first.value === null;
        if (isObjectCall(node, new Set(["create"])) && !isNullCreate) reportPrototype(node);
        if (isObjectCall(node, new Set(["setPrototypeOf"]))) reportPrototype(node);
        if (isObjectCall(node, FILLS) && isLocalFunction(prototypeOwner(first)))
          reportPrototype(node);
        const { callee } = node;
        const isReflect = callee.type === "MemberExpression" && callee.object.name === "Reflect";
        if (isReflect && propertyName(callee) === "setPrototypeOf") reportPrototype(node);
      },
      Property(node) {
        const isProto = !node.computed && (node.key.name ?? node.key.value) === "__proto__";
        if (isProto && node.parent.type === "ObjectExpression") reportPrototype(node);
      },
    };
  },
};

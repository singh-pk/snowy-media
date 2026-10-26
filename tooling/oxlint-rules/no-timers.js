// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

// Code waits on events, never on time: no timer, and no wait with a time limit.
// requestIdleCallback is allowed, since it runs when the browser is idle rather than after a
// time, but not its `timeout` option, which turns it back into a delay; nor
// `scheduler.postTask` with a `delay`.

import { isObjectKey, isPropertyRead } from "./ast.js";

const TIMERS = new Set(["setTimeout", "setInterval"]);
// Bun's sleeps, which a test would otherwise wait on.
const SLEEPS = new Set(["sleep", "sleepSync"]);
const WAITS = new Set(["wait", "waitAsync"]);
// What each global holds that the rule bans when it is read apart from a call it can check.
const HELD = {
  globalThis: TIMERS,
  window: TIMERS,
  self: TIMERS,
  Bun: SLEEPS,
  Atomics: WAITS,
  AbortSignal: new Set(["timeout"]),
};
// Modules that export timers.
const TIMER_MODULES = /^(node:)?timers(\/promises)?$/;

// The string `node` spells out, as `"name"` or `\`name\``, or "".
function staticString(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? "";
  return "";
}

// The name a member expression reads: `o.name`, `o["name"]` or `o[\`name\`]`.
function propertyName(member) {
  return member.computed ? staticString(member.property) : member.property.name;
}

// The name a destructuring property takes: `{ name }`, `{ name: x }` or `{ ["name"]: x }`.
function keyName(property) {
  return property.computed
    ? staticString(property.key)
    : (property.key?.name ?? property.key?.value);
}

// The global `node` names, as `Atomics` or `globalThis.Atomics`, or "".
function globalName(node) {
  const name =
    node.type === "Identifier"
      ? node.name
      : node.type === "MemberExpression"
        ? propertyName(node)
        : "";
  return Object.hasOwn(HELD, name) ? name : "";
}

// Whether `node` is the global `name`, or `globalThis.name` and the like.
function isGlobal(node, name) {
  if (node.type === "Identifier") return node.name === name;
  return node.type === "MemberExpression" && propertyName(node) === name;
}

// Whether `node` is Infinity, or Number.POSITIVE_INFINITY.
function isInfinite(node) {
  if (node.type === "Identifier") return node.name === "Infinity";
  const isMember = node.type === "MemberExpression" && propertyName(node) === "POSITIVE_INFINITY";
  return isMember && isGlobal(node.object, "Number");
}

// Whether `node` is only named in a type, as `ReturnType<typeof setTimeout>`.
function inType(node) {
  for (let up = node.parent; up; up = up.parent) {
    if (up.type === "TSTypeQuery") return true;
    if (!up.type.startsWith("TS") && up.type !== "Identifier") return false;
  }

  return false;
}

// Whether the arguments of an Atomics wait give it a time limit: a fourth argument other than
// Infinity, or a spread that may hold one.
function isTimed(args) {
  if (args.some((a) => a.type === "SpreadElement")) return true;
  const limit = args[3];
  return limit !== undefined && !isInfinite(limit);
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

// Whether `node` is the second of two nodes for one name, `{ a }` or `export { a }`, which the
// first already stands for.
function isNamedTwice(node) {
  const { parent } = node;
  if (parent.type === "Property" && parent.shorthand) return parent.value === node;
  return parent.type === "ExportSpecifier" && parent.exported === node && parent.local !== node;
}

// Whether `node` is called right where it is named, as `f()` or `o.f()`, so its options show.
function isCalledInPlace(node) {
  const member = node.parent?.type === "MemberExpression" && node.parent.property === node;
  const callee = member ? node.parent : node;
  return callee.parent?.type === "CallExpression" && callee.parent.callee === callee;
}

// `const { sleep } = Bun`, `const { ...rest } = Atomics` or `const A = Atomics`: what
// the global holds, under a name the rule no longer follows.
function reportTaken(context, node) {
  const holder = node.init ? globalName(node.init) : "";
  if (holder === "") return;

  if (node.id.type !== "ObjectPattern") {
    if (holder !== "globalThis" && holder !== "window" && holder !== "self")
      context.report({ node, messageId: "unseen", data: { name: holder } });
    return;
  }

  const held = HELD[holder];
  // A timer under a plain key is the Identifier visitor's to report.
  const own = node.id.properties.filter(
    (p) =>
      held !== TIMERS || p.type === "RestElement" || p.computed || Object.hasOwn(HELD, keyName(p)),
  );
  const taken = own.map((p) => (p.type === "RestElement" ? "..." : keyName(p)));
  // `const { Bun: B } = globalThis` takes a holder, whose members the rule no longer sees.
  const name = taken.find((k) => k === "..." || held.has(k) || Object.hasOwn(HELD, k));
  if (name) context.report({ node, messageId: "unseen", data: { name: `${holder}.${name}` } });
}

// `import { sleep } from "bun"`, or anything from `node:timers`, imported or exported.
function reportImport(context, node) {
  const from = staticString(node.source);
  const imported = (node.specifiers ?? []).map(
    (s) => s.imported?.name ?? s.imported?.value ?? s.local?.name ?? "*",
  );
  const isTimers = TIMER_MODULES.test(from);
  const sleep = imported.find((name) => name === "*" || SLEEPS.has(name));
  if (!isTimers && !(from === "bun" && sleep)) return;
  context.report({
    node,
    messageId: "timer",
    data: { name: isTimers ? from : `Bun.${sleep}` },
  });
}

export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      timer: "Do not use {{name}}. Wait on the event that ends the wait.",
      idleTimeout:
        "Do not give requestIdleCallback a `timeout`: it forces the work after a delay. Wait on the event that makes it urgent.",
      timedWait: "Do not give Atomics.{{name}} a time limit. Wait until the value changes.",
      unseen:
        "Do not take {{name}} away from its call: the rule can then no longer see whether it waits on time. Call it where it is named.",
    },
  },
  create(context) {
    return {
      // Any use of a timer's name, called or passed on: `setTimeout`, `globalThis.setTimeout`,
      // `const { setTimeout } = globalThis`.
      Identifier(node) {
        if (!TIMERS.has(node.name) || isPropertyRead(node) || inType(node)) return;
        // An import or re-export from a timer module is reportImport's to report.
        if (node.parent?.type === "ImportSpecifier") return;
        if (node.parent?.type === "ExportSpecifier" && node.parent.parent?.source) return;
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
        const holder = globalName(node.object);
        const isCall = node.parent?.type === "CallExpression" && node.parent.callee === node;

        // `globalThis["setTimeout"]`, or `globalThis.setTimeout` read and not called, which the
        // Identifier visitor leaves to this one.
        if (TIMERS.has(name) && (node.computed || (holder !== "" && !isCall))) {
          context.report({ node, messageId: "timer", data: { name } });
        }

        if (holder === "Atomics" && WAITS.has(name) && !isCall) {
          context.report({ node, messageId: "unseen", data: { name: `Atomics.${name}` } });
        }

        if (name === "timeout" && isGlobal(node.object, "AbortSignal")) {
          context.report({ node, messageId: "timer", data: { name: "AbortSignal.timeout" } });
        }

        if (SLEEPS.has(name) && isGlobal(node.object, "Bun")) {
          context.report({ node, messageId: "timer", data: { name: `Bun.${name}` } });
        }
      },
      VariableDeclarator: (node) => reportTaken(context, node),
      ImportDeclaration: (node) => reportImport(context, node),
      ImportExpression: (node) => reportImport(context, node),
      ExportAllDeclaration: (node) => reportImport(context, node),
      ExportNamedDeclaration: (node) => node.source && reportImport(context, node),
      // `scheduler.postTask` renamed or handed on, whose options the rule can no longer see.
      "Identifier[name='postTask']"(node) {
        const { parent } = node;
        if (isCalledInPlace(node) || parent.type.startsWith("TS") || isNamedTwice(node)) return;
        if (parent.type === "MemberExpression" && parent.object === node) return;
        if (isObjectKey(node) && node.parent.parent?.type !== "ObjectPattern") return;
        context.report({ node, messageId: "timer", data: { name: "scheduler.postTask, renamed" } });
      },
      CallExpression(node) {
        const { callee } = node;
        const isMember = callee.type === "MemberExpression";
        const name = isMember ? propertyName(callee) : callee.name;
        const options = node.arguments[1];

        if (name === "requestIdleCallback" && hasOption(options, "timeout")) {
          context.report({ node, messageId: "idleTimeout" });
        }

        // `Reflect.get(globalThis, "setTimeout")` or `Reflect.get(Bun, "sleep")`: a timer by
        // another name.
        const key = staticString(node.arguments[1]);
        const from = node.arguments[0] ? globalName(node.arguments[0]) : "";
        const isReflect = isMember && name === "get" && isGlobal(callee.object, "Reflect");

        if (isReflect && HELD[from]?.has(key)) {
          context.report({ node, messageId: "timer", data: { name: key } });
        }

        if (name === "postTask" && hasOption(options, "delay")) {
          context.report({
            node,
            messageId: "timer",
            data: { name: "scheduler.postTask with a delay" },
          });
        }

        const isWait = isMember && isGlobal(callee.object, "Atomics") && WAITS.has(name);
        if (isWait && isTimed(node.arguments))
          context.report({ node, messageId: "timedWait", data: { name } });
      },
    };
  },
};

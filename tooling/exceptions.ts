// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The exceptions to the checks in one file's source, read from outside them, since a
// file-wide disable can turn off the lint rule that would report it:
// - no `oxlint-disable` or `eslint-disable` for a block or a file, only for one line
//   (tooling/oxlint-rules/disable-needs-reason.js holds the rest of such a directive), and none
//   that turns off `repo/disable-needs-reason` itself;
// - every ignore-start marker of jscpd says why, in a few words after a colon, and has its
//   ignore-end marker after it, wherever in a comment jscpd finds them.
// Comments are found as the tools find them, past strings, templates and regular expressions.

const DIRECTIVE = /^(oxlint|eslint)-disable(-next-line|-line)?(?=\s|$)/;
// A directive that names its rules before any `--` reason.
const NAMED = /^\S+\s+(?!--)\S/;
// At least three words after the colon.
const START_REASON = /jscpd:ignore-start:\s*\S+\s+\S+\s+\S/;
// Words after which a `/` starts a regular expression rather than dividing.
const BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
]);

interface Comment {
  line: number;
  text: string;
}

// The end of the quoted string opening at `start`.
function stringEnd(text: string, start: number) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length && text[i] !== quote && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
  return i + 1;
}

// The end of the regular expression opening at `start`, past its classes and escapes.
function regexEnd(text: string, start: number) {
  const at = { i: start + 1, inClass: false };

  for (; at.i < text.length && text[at.i] !== "\n"; at.i++) {
    const char = text[at.i];
    if (char === "\\") at.i++;
    else if (char === "[") at.inClass = true;
    else if (char === "]") at.inClass = false;
    else if (char === "/" && !at.inClass) break;
  }

  return at.i + 1;
}

// Whether a `/` starts a regular expression, from `last`, the index of the code character
// before it. After `)` it is read as division, so `if (x) /re/` is misread: the repository
// braces every `if`, which keeps that form out.
function startsRegex(text: string, last: number) {
  const char = text[last] ?? "";
  const before = text[last - 1] ?? "";
  // `v! / 2` and `i++ / 2` divide: TypeScript's non-null `!`, and a postfix step.
  if (char === "!" && /[\w$)\]]/.test(before)) return false;
  if ((char === "+" || char === "-") && before === char) return false;
  if (char === "" || "(,=:[!&|?{};+-*%<>~^".includes(char)) return true;
  const word = /[\w$]+$/.exec(text.slice(0, last + 1))?.[0] ?? "";
  return BEFORE_REGEX.has(word);
}

/** Every comment in `text`, with the line it starts on. */
function comments(text: string) {
  const found: Comment[] = [];
  // The brace depth at which each open template's `${` returns to the template.
  const templates: number[] = [];
  // `code`: the index of the last character of code, which comments leave as it was.
  const at = { i: 0, line: 1, depth: 0, code: -1 };

  const advance = (to: number) => {
    for (let j = at.i; j < to && j < text.length; j++) if (text[j] === "\n") at.line++;
    at.i = to;
  };

  // The rest of a template from `at.i`, up to its end or its next `${`.
  const template = () => {
    let j = at.i;

    while (j < text.length && text[j] !== "`") {
      if (text[j] === "\\") j++;
      else if (text[j] === "$" && text[j + 1] === "{") {
        templates.push(at.depth);
        at.depth++;
        advance(j + 2);
        return;
      }

      j++;
    }

    advance(j + 1);
  };

  while (at.i < text.length) {
    const char = text[at.i];
    const next = text[at.i + 1];

    if (char === "/" && (next === "/" || next === "*")) {
      const end = next === "/" ? text.indexOf("\n", at.i) : text.indexOf("*/", at.i + 2);
      const stop = end === -1 ? text.length : end;
      found.push({ line: at.line, text: text.slice(at.i + 2, stop).trim() });
      advance(next === "/" ? stop : stop + 2);
    } else if (char === '"' || char === "'") {
      advance(stringEnd(text, at.i));
      at.code = at.i - 1;
    } else if (char === "`") {
      advance(at.i + 1);
      template();
      at.code = at.i - 1;
    } else if (char === "/" && startsRegex(text, at.code)) {
      advance(regexEnd(text, at.i));
      at.code = at.i - 1;
    } else if (char === "}" && templates.at(-1) === at.depth - 1) {
      templates.pop();
      at.depth--;
      advance(at.i + 1);
      template();
      at.code = at.i - 1;
    } else {
      if (char === "{") at.depth++;
      if (char === "}") at.depth--;
      if (!/\s/.test(char ?? "")) at.code = at.i;
      advance(at.i + 1);
    }
  }

  return found;
}

/** The problems with the exceptions in `text`, each with its line. */
export function exceptions(text: string) {
  const problems: Comment[] = [];
  const open = { line: 0 };

  for (const comment of comments(text)) {
    const directive = DIRECTIVE.exec(comment.text);

    if (directive && !directive[2]) {
      problems.push({ line: comment.line, text: "a disable for a block or a file, not one line" });
    }

    // Without rules, a directive turns off every rule there, the one that checks it too.
    if (directive && !NAMED.test(comment.text)) {
      problems.push({ line: comment.line, text: "a disable that names no rule" });
    }

    const rules = comment.text.split(/\s--\s/)[0] ?? "";

    if (directive && /\brepo\/disable-needs-reason\b/.test(rules)) {
      problems.push({ line: comment.line, text: "a disable of the rule that checks disables" });
    }

    if (comment.text.includes("jscpd:ignore-start")) {
      if (!START_REASON.test(comment.text))
        problems.push({ line: comment.line, text: "jscpd:ignore-start without a reason" });
      if (open.line > 0)
        problems.push({ line: comment.line, text: "jscpd:ignore-start inside another" });
      open.line = comment.line;
    } else if (comment.text.includes("jscpd:ignore-end")) {
      if (open.line === 0)
        problems.push({ line: comment.line, text: "jscpd:ignore-end without a start" });
      open.line = 0;
    }
  }

  if (open.line > 0) problems.push({ line: open.line, text: "jscpd:ignore-start without an end" });
  return problems;
}

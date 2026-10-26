// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

// Documents say what is there, plainly. The rule reports marketing words that claim instead of
// show ("robust", "seamless", "powerful"), plan markers (a to-do marker, "next steps",
// "Phase 2"), and emoji in headings. It reads only prose, as micromark parses it: code, link
// targets, definitions, autolinks and HTML are not prose.

const SLOP = [
  /\bcomprehensive(ly)?\b/i,
  /\bseamless(ly)?\b/i,
  /\brobust(ly|ness)?\b/i,
  /\bblazing(ly)?\b/i,
  /\bleverag(e|es|ed|ing)\b/i,
  /\bdelv(e|es|ed|ing)\b/i,
  /\bpowerful\b/i,
  /\bcutting-edge\b/i,
  /\beffortless(ly)?\b/i,
  /\bgame-chang\w*/i,
  /\bsupercharg\w*/i,
  /\bempower\w*/i,
  /\b(world|best-in)-class\b/i,
  /\bstate-of-the-art\b/i,
  /\bnext steps\b/i,
  /\bPhase \d+\b/,
  /\bTBD\b/,
  // A task-list item of work left: micromark splits off its box's `[`, leaving ` ] ` before the marker.
  /^[ xX]?\]\s*(TODO|FIXME)\b/,
  /\b(TODO|FIXME|XXX)\s*[:(]/,
];
// Pictographs drawn as emoji, not symbols such as ™ or ↔ that only may be.
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u;
const NOT_PROSE = new Set(["resource", "definition", "autolink", "htmlFlow", "htmlText"]);
const HEADINGS = new Set(["atxHeading", "setextHeading"]);

function within(token, types) {
  for (let parent = token.parent; parent; parent = parent.parent) {
    if (types.has(parent.type)) return true;
  }

  return false;
}

// Every `data` token, the text micromark reads as prose, below `tokens`.
function* data(tokens) {
  for (const token of tokens) {
    if (token.type === "data") yield token;
    yield* data(token.children);
  }
}

export default {
  names: ["no-slop"],
  description: "Plain prose: no marketing words, plan markers or emoji in headings",
  tags: ["prose"],
  parser: "micromark",
  function(params, onError) {
    for (const token of data(params.parsers.micromark.tokens)) {
      if (within(token, NOT_PROSE)) continue;
      const lineNumber = token.startLine;
      const word = SLOP.map((re) => re.exec(token.text)?.[0]).find(Boolean);
      if (word) onError({ lineNumber, detail: `"${word}"` });

      if (within(token, HEADINGS) && EMOJI.test(token.text)) {
        onError({ lineNumber, detail: "An emoji in a heading" });
      }
    }
  },
};

// expected lines: 3 6 7 8 9 10 13 14 15 16 17 21
declare const n: number;
/*
oxlint-disable no-debugger -- a reason of words
*/
export const url = "https://x"; /* oxlint-disable no-debugger -- a reason of words */
export const re = /\/\//; /* oxlint-disable no-debugger -- a reason of words */
export const tpl = `${"//"}`; /* oxlint-disable no-debugger -- a reason of words */
export const own = n; // oxlint-disable-line no-debugger, repo/disable-needs-reason
// see jscpd:ignore-start
export const half = n / 2;
// jscpd:ignore-end
// jscpd:ignore-end
// jscpd:ignore-start: a reason of words
export const bare = n; // oxlint-disable-line
export const bang = n! / 2; /* oxlint-disable no-debugger -- a reason of words */
export const post = n++ / 2; /* oxlint-disable no-debugger -- a reason of words */
export const R =
  // a quote
  /`/;
/* oxlint-disable no-debugger -- a reason of words */

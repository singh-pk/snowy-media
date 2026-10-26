declare const n: number;

export const quoted = "/* oxlint-disable */";
export const single = '// oxlint-disable';
export const template = `/* oxlint-disable ${n} */ // oxlint-disable`;
export const pattern = /\/\* oxlint-disable [/]/u;
export const divided = n / 2 / 3;
// oxlint-disable-next-line no-debugger -- a reason of words
export const one = n;
// jscpd:ignore-start: it mirrors the other package
export const mirrored = n;
// jscpd:ignore-end
// oxlint-disable-next-line no-debugger -- unlike repo/disable-needs-reason it is fine
export const mention = n;

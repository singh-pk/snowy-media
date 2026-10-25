// expected lines: 7 8 9 10 11 12 13 14 15 16 17 18 20 21 22 24 27 28 29
declare const xs: number[];
declare const bytes: Uint8Array;
declare const seen: Map<string, number>;
declare const buffer: GPUBuffer;

export const a = [...xs];
export const b = { ...seen };
export const c = Array.from(seen);
export const d = bytes.slice(0, 4);
export const e = xs.concat(xs);
export const f = xs.toSorted();
export const g = structuredClone(xs);
export const h = Object.assign({}, seen);
export const i = seen.keys().toArray();
export const j = Math.max(...xs);
export const k = buffer.mapAsync(GPUMapMode.READ);
export const l = xs.toReversed();
// A comment that gives no reason.
export const m = [...xs];
export const n = xs.toSpliced(0, 1);
export const grown = [...(xs ?? []), 1];
export const o = xs.slice(); // copy: a reason for this line only
export const p = xs.slice();
export const q = xs.slice(); // copy: and this one
// An unrelated note about the next line.
export const r = xs.toSorted();
export const s = xs.with(0, 1);
export const t = globalThis.structuredClone(xs);

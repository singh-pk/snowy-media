declare const xs: number[];
declare const seen: Map<string, number>;
declare const frame: VideoFrame;
declare const into: Uint8Array;

// copy: the queue is changed in place, and the caller's array must not be.
export const queue = [...xs];
export const sorted = xs.slice(); // copy: sorted below, without reordering the caller's
export const layout = frame.copyTo(into); // readback: the planes are converted on the CPU
// copy: a snapshot, as `seen` keeps changing
// while the caller reads it.
export const snapshot = new Map(
  [...seen],
);
export const squares = Array.from(xs, (x) => x * x);
export const zeros = Array.from({ length: 4 }, () => 0);
export const keys = seen.keys().filter((k) => k !== "").toArray();
export const merged = Object.assign(seen, { size: 1 });
export const view = new Uint8Array(into.buffer);

export function call(handler: (...args: number[]) => void, ...args: number[]) {
  handler(...args);
}

export const optional = { a: 1, ...(xs.length > 0 ? { first: xs[0] } : {}) };
export const maybe = [1, ...(xs.length > 0 ? [2] : [])];
export const flagged = { ...(xs.length > 0 && { any: true }) };

export function outer(...args: number[]) {
  return () => Math.max(...args);
}

declare const value: object;

export const worker = new Worker(new URL("./job.js", import.meta.url), { type: "module" });
export const loaded = await import("./job.js");
export const kind = value.constructor.name;
export const url = URL.createObjectURL(new Blob(["frame"]));
declare const array: Float32Array;

export const copy = new array.constructor(4);
export const same = array.constructor === Float32Array;
export const isFn = (v: unknown) => v instanceof Function;
export type Fn = Function;

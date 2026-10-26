// expected lines: 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26
declare const code: string;
declare const context: AudioContext;

export const run = (() => {}).constructor("return 1");
export const later = new (async () => {}).constructor("await 1");
export const worker = new Worker(URL.createObjectURL(new Blob([code])));
export const shared = new SharedWorker("data:text/javascript,1");
export const loaded = await import("data:text/javascript,export default 1");
export const fetched = await import(`blob:${code}`);
export const computed = (() => {})["constructor"]("return 1");
export const called = (() => {}).constructor.call(null, "return 1");
export const taken = (() => {}).constructor;
export const global = globalThis.Function("return 1");
export const built = Reflect.construct(Function, ["return 1"]);
export const joined = new Worker("data:text/javascript," + code);
export const imported = await import("data:text/javascript," + code);
export const spaced = new Worker(" data:text/javascript,1");
export const scoped = new globalThis.Worker("data:text/javascript,1");
await context.audioWorklet.addModule(URL.createObjectURL(new Blob([code])));
export const sized = new (() => {}).constructor(code);
const F = Function;
const { constructor: G } = () => {};
const { Function: H } = globalThis;
export const got = Reflect.get(() => {}, "constructor");
export const listed = [Function];
export { F, G, H };

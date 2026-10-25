// expected lines: 5 6 7 8 9 10 11 12 13
declare const scheduler: { postTask(f: () => void, o: object): void };
declare const shared: Int32Array;

setTimeout(() => {}, 10);
globalThis.setTimeout(() => {}, 10);
const { setTimeout: later } = globalThis;
requestIdleCallback(() => {}, { timeout: 50 });
window.requestIdleCallback(() => {}, { "timeout": 50 });
scheduler.postTask(() => {}, { delay: 10 });
Atomics.wait(shared, 0, 0, 100);
export const signal = AbortSignal.timeout(100);
export const pending = Atomics.waitAsync(shared, 0, 0, 5);
export { later };

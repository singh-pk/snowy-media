// expected lines: 7 8 9 10 11 12 13 14 15 16 17 18 19
declare const scheduler: { postTask(f: () => void, o: object): void };
declare const shared: Int32Array;
declare const opts: IdleRequestOptions;
declare const later: { delay: number };

setTimeout(() => {}, 10);
globalThis.setTimeout(() => {}, 10);
const { setTimeout: wait } = globalThis;
requestIdleCallback(() => {}, { timeout: 50 });
window.requestIdleCallback(() => {}, { "timeout": 50 });
requestIdleCallback(() => {}, opts);
requestIdleCallback(() => {}, { ...opts });
const { requestIdleCallback: idle } = globalThis;
scheduler.postTask(() => {}, { delay: 10 });
scheduler.postTask(() => {}, later);
Atomics.wait(shared, 0, 0, 100);
export const signal = AbortSignal.timeout(100);
export const pending = Atomics.waitAsync(shared, 0, 0, 5);
export { wait, idle };

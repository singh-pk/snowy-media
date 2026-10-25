declare const scheduler: { postTask(f: () => void, o: object): void };
declare const shared: Int32Array;

requestIdleCallback(() => {});
scheduler.postTask(() => {}, { priority: "background" });
Atomics.wait(shared, 0, 0);
Atomics.wait(shared, 0, 0, Infinity);
const options = { setTimeout: 1 };
const read = globalThis.setTimeout === undefined;
export { options, read };

declare const scheduler: { postTask(f: () => void, o: object): void };
declare const shared: Int32Array;

requestIdleCallback(() => {});
scheduler.postTask(() => {}, { priority: "background" });
Atomics.wait(shared, 0, 0);
Atomics.wait(shared, 0, 0, Infinity);
Atomics.wait(shared, 0, 0, Number.POSITIVE_INFINITY);
type Handle = ReturnType<typeof setTimeout>;
const options = { setTimeout: 1 };
clearInterval(undefined);
export type { Handle };
export { options };
import { $ } from "bun";
export const shell = $;
export const big = Atomics.wait(shared, 0, 0, Number.POSITIVE_INFINITY);

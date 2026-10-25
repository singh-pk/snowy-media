// expected lines: 5 8 9 10 11 12 16 17 18 19 19
declare const base: object;

function Queue(this: { items: number[] }) {
  this.items = [];
}

export const queue = new Queue();
Queue.prototype.size = 0;
export const copy = Object.create(base);
export const self = { name: "a", get() { return this.name; } };
Object.assign(Queue.prototype, { push() {} });

export function outer() {
  function Inner() {}
  Object.setPrototypeOf(Inner, base);
  Reflect.setPrototypeOf(Inner, base);
  Queue["prototype"].push = () => {};
  return [new Inner(), { __proto__: base }];
}

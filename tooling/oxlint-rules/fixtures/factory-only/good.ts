export class DecodeError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DecodeError";
  }
}

export function createQueue() {
  const items: number[] = [];
  return { push: (n: number) => items.push(n), size: () => items.length };
}

export const error = new DecodeError("bad");
export const map = new Map<string, number>();

AudioContext.prototype.resume = () => new Promise<void>(() => {});
export const dictionary: Record<string, number> = Object.create(null);

export function shadowed(Queue: new () => object) {
  return new Queue();
}

function Queue() {
  return {};
}

export const made = Queue();

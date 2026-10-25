export class DecodeError extends Error {}

export function createQueue() {
  const items: number[] = [];
  return { push: (n: number) => items.push(n), size: () => items.length };
}

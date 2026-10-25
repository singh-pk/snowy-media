export function createCounter() {
  let count = 0;
  return () => ++count;
}

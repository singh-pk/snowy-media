// expected lines: 4 7
export function f(xs: number[]) {
  let sum = 0;
  for (const x of xs) {
    sum += x;
  }
  return sum;
}

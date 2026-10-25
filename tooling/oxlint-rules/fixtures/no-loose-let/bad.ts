// expected lines: 2 3 8 20
let count = 0;
export let total = 0;
count += 1;
total += count;

export function parse(text: string) {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    throw new SyntaxError("not JSON");
  }

  return value;
}

export function sum(xs: number[], on: boolean) {
  let total = 0;

  if (on) {
    for (const x of xs) total += x;
    return total;
  }

  return 0;
}

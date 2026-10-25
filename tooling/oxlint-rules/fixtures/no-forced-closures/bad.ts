// expected lines: 2 3 4 5 10 15
export const value = (() => 1)();
export const later = (async () => 2)();
export const cast = ((() => 3) as () => number)();
export const called = function () { return 4; }.call(undefined);

declare const items: { size: number }[];

for (const item of items) {
  const double = (n: number) => n * 2;
  console.log(double(item.size));
}

for (const item of items) {
  function countdown(n: number): number {
    return n > 0 ? countdown(n - 1) : 0;
  }

  console.log(countdown(item.size));
}

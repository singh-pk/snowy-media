declare const items: { size: number; onDone?: () => void }[];
declare function watch(options: { onChange: () => void }): void;

const double = (n: number) => n * 2;

for (const item of items) {
  console.log(double(item.size));
  item.onDone = () => console.log(item.size);
  watch({ onChange: () => console.log("changed") });
  console.log([1, 2].map((n) => n + 1));
}

function first() {
  return 1;
}

export const value = first();

declare function use(v: unknown): void;
declare const fallback: (() => number) | undefined;

export function find() {
  for (const item of items) {
    use((() => 1) as unknown);
    use(fallback ?? (() => 1));
    use(item.size > 0 ? () => 1 : () => 2);
    use([() => 1]);
    use({ nested: { f: () => 1 } });
    if (item.size > 9) return { dispose: () => 1 };
    if (item.size < 0) throw Object.assign(new Error("negative"), { retry: () => 1 });
  }

  return undefined;
}

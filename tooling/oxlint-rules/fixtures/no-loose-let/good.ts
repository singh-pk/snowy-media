declare function open(): { close(): void; read(): number };

export function createCounter() {
  let count = 0;
  return () => ++count;
}

export function read() {
  let file: ReturnType<typeof open> | undefined;

  try {
    file = open();
    return file.read();
  } finally {
    file?.close();
  }
}

export function last(xs: number[]) {
  let found: number | undefined;
  for (const x of xs) if (x > 0) found = x;
  return found;
}

export function kind(audio: boolean) {
  let name: string;
  if (audio) name = "audio";
  else name = "video";
  return name;
}

export function running(xs: number[]) {
  let previous = 0;

  for (const x of xs) {
    if (x < previous) return false;
    previous = x;
  }

  return true;
}

declare function parse(text: string): number;
declare function use(n: number): void;

export function parsed(texts: string[]) {
  for (const text of texts) {
    let value: number;

    try {
      value = parse(text);
    } catch {
      continue;
    }

    use(value);
  }
}

export function timed(on: boolean) {
  let start = performance.now();
  use(0);

  if (on) {
    start = performance.now() - start;
    use(start);
  }
}

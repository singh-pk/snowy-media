// expected lines: 3 3
declare function load(): Promise<number>;
export const size = load().then((n) => n * 2).catch(() => 0);

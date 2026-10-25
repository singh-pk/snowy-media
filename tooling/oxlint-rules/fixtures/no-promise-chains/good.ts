declare function load(): Promise<number>;

export async function size() {
  try {
    const n = await load();
    return n * 2;
  } catch {
    return 0;
  }
}

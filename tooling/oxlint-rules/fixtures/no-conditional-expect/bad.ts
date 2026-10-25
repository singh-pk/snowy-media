// expected lines: 8 9 10 15 20 27 36 39
declare function test(name: string, body: () => unknown): void;
declare function expect(v: unknown): { toBe(w: unknown): void };
declare const got: { ok?: boolean; value: number; list?: number[] };
declare function run(): Promise<number>;

test("branches", () => {
  if (got.ok) expect(got.value).toBe(1);
  got.ok && expect(got.value).toBe(1);
  const v = got.ok ? expect(got.value).toBe(1) : undefined;

  try {
    JSON.parse("{");
  } catch {
    expect(v).toBe(undefined);
  }
});

test("a guard before every expect", () => {
  if (!got.ok) return;

  expect(got.value).toBe(1);
});

test("a guard in a loop", () => {
  for (const v of got.list ?? []) {
    if (v < 0) continue;

    expect(v).toBe(1);
  }
});

test("skipped when it throws", async () => {
  try {
    const n = await run();
    expect(n).toBe(1);
  } catch {}

  got.list?.forEach((v) => expect(v).toBe(1));
});

// expected lines: 7 8 9 14
declare function test(name: string, body: () => unknown): void;
declare function expect(v: unknown): { toBe(w: unknown): void };
declare const got: { ok?: boolean; value: number };

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

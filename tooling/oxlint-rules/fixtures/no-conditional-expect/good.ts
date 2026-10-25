declare function test(name: string, body: () => unknown): void;
declare function expect(v: unknown): { toBe(w: unknown): void };
declare const cases: { input: number; want: number }[];

test("every case", () => {
  for (const { input, want } of cases) expect(input * 2).toBe(want);
  expect(cases.length > 0 ? "some" : "none").toBe("some");
});

declare const got: Record<string, { decoder?: string; codec: string }>;

test("every path asserts", () => {
  for (const [file, result] of Object.entries(got)) {
    if (result.decoder) {
      expect(result.decoder).toBe("video");
      continue;
    }

    expect(result.codec).toBe(file);
  }

  if (cases.length > 2) expect(cases[0]).toBe(1);
  else expect(cases.length).toBe(2);
});

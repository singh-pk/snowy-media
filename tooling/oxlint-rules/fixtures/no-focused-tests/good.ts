declare function test(name: string, body: () => void): void;
declare function expect(v: unknown): { toBe(w: unknown): void };
test("a", () => expect(1).toBe(1));

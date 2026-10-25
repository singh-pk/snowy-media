// expected lines: 9 13 17
declare function test(name: string, body: () => unknown): void;
declare function expect(v: unknown): { toBe(w: unknown): void };

function run() {
  return 1;
}

test("runs", () => {
  run();
});

test("awaits", async () => {
  await Promise.resolve();
});

test("defines a check it never calls", () => {
  const later = () => expect(1).toBe(1);
  return later;
});

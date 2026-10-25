declare function test(name: string, body: () => unknown): void;
declare function describe(name: string, body: () => void): void;
declare function expect(v: unknown): { toBe(w: unknown): void };

function check(v: number) {
  expect(v).toBe(1);
}

const checkTwice = (v: number) => {
  check(v);
  check(v);
};

test("directly", () => expect(1).toBe(1));
test("through a helper", () => check(1));
test("through a helper's helper", () => checkTwice(1));
test("in a callback it runs", () => [1, 2].forEach((v) => expect(v > 0).toBe(true)));

describe("a group", () => {
  function inGroup() {
    expect(2).toBe(2);
  }

  test("through a helper in the group", () => inGroup());
});
test("in a promise it awaits", async () => {
  await new Promise<void>((resolve) => {
    expect(1).toBe(1);
    resolve();
  });
});

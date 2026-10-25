// expected lines: 3 4 5 6
declare const test: { only: Function; skip: Function; todo: Function; skipIf: Function };
test.only("a", () => {});
test.skip("b", () => {});
test.todo("c");
test.skipIf(true)("d", () => {});

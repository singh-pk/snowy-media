---
name: verify-tests
description: Probe whether a Snowy package's tests check its code, by making small deliberate bugs in src/ and seeing which no test catches. Use on committed code, after writing tests, when coverage is high but trust is low, or as part of audit-package.
---

# Verify that the tests check the code

Coverage shows a line ran; this shows a test would notice it going wrong. Work in `packages/<p>`, on a clean tree: commit or stash your work first, so `git status --short` prints nothing. Putting a file back with `git checkout` would otherwise lose what was not committed.

1. **Pick the code.** The functions the change touched, or those named, or for an audit the central modules. Note which test files exercise them.
2. **Make one bug at a time,** 3 to 5 per function, each the kind a real change could make:
   - flip a comparison (`<` to `<=`, `===` to `!==`) or a sign;
   - move a bound by one;
   - drop a branch, an early return or an `else`;
   - skip a free, close, cancel or unsubscribe;
   - swap two arguments of the same type;
   - return the input unchanged, or an empty result.
3. **Run the tests** that cover it (`bun run test`, or the package's narrower command). A mutation that fails a test is caught. One that passes every test survives. One that fails to build or typecheck doesn't count; make a different one.
4. **Put the file back** after each run with `git checkout -- <file>`, before making the next bug.
5. **Report** each surviving bug: the file and line, the change, and the test that should have caught it, with what it would assert. Count caught against survived per file.
6. **End clean.** `git status --short` prints nothing, as at the start. Never commit a mutation, and never change a test to make a mutation fail in this skill: the report is the output.

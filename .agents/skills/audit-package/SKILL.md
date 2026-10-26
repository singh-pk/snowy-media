---
name: audit-package
description: Audit a whole Snowy package against the repository standards and its own Review section, and rank what is wrong by impact. Use when asked to audit, review or clean up a package rather than a diff.
---

# Audit a package

Paths are relative to the repository root; `<p>` is the package's directory name, such as `engine`.

1. **Read the standards.** The root `AGENTS.md` (rules and `## Standards`), then `packages/<p>/AGENTS.md` (rules, Map and `## Review`) and `packages/<p>/docs/architecture.md`.
2. **Run what machines check,** and keep their output as the first part of the report:
   - `bun run check`;
   - for a package with a `coverage-floor.json` (not ffmpeg): `SNOWY_COVERAGE=1 bun run test` in `packages/<p>`, then `bun tooling/check-coverage.ts <p>` from the root (engine's floors hold on macOS only, where CI measures them); list the files with the lowest coverage and what their uncovered lines do.
3. **Boundaries.** For each `src/` file, read it against its Map row. Report a file doing more than its row says, two files sharing one job, a name that doesn't say what the file holds, and code that belongs in another file.
4. **The `## Review` dimensions.** Go through every file for each dimension the package lists, such as copies in the engine or bytes on the wire in sync. Back each finding with the line and, for performance, a measurement or the reason one is needed.
5. **The review rows of `## Standards`:** names, comments, one way per concern, nothing written twice.
6. **Tests.** Run the `verify-tests` skill on the package's central modules: those most of `src/` imports, and those with the most logic per line.
7. **Report** in the scratchpad, never in the repository (root rule 8). Rank findings bug first, then rule, then dimension, then clarity. For each, give `path:line`, what is wrong, the root cause and the smallest fix. Say what you checked and found sound, so the report shows its coverage.

For a large package, run steps 3 to 6 as one subagent per dimension, each given the files and the standard it checks. Check every finding a subagent returns against the code before it goes in the report.

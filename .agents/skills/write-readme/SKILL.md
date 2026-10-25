---
name: write-readme
description: Write or rewrite a Snowy package's README in the shape bun run lint:structure checks, without marketing language. Use when adding a package or when a package's public API changes.
---

# Write a package README

The README is for someone deciding whether to use the package and how to start. Design rationale goes in `docs/`, not here.

**Shape**, as the engine's README has it (`bun run lint:structure` checks the length, the diagram and the last heading):

1. The Snowy mark (`<picture>`), `# @snowy-media/<name>`, and the CI and licence badges, copied from another package's README.
2. One paragraph: what the package is, what it builds on, and what it is not.
3. A `> [!NOTE]` on its state: how to install it, and what works so far, with a link to the changelog.
4. `## How it works`: a ` ```mermaid ` diagram of the parts and what flows between them, named as the code names them, with at most a short paragraph under it. A part the code doesn't have yet is marked as designed.
5. `## Requirements`, for a package with a platform baseline: what the page must provide, and the shortest real example of use, taken from a test or the public types, never invented. Every name in it exists in `src/index.ts`.
6. Further sections only as needed, such as a table of modules or links into `docs/`.
7. `## Licence` last.

At most 150 lines in all.

**Wording.** Plain statements of what is there. `bun run lint:md` reports marketing words (`robust`, `seamless`, `powerful`, `blazing`), plan markers (`TODO:`, `next steps`, `Phase 2`) and emoji in headings; a roadmap or what is coming is a plan too, and stays out (root rule 8). Don't claim a speed without a number from the package's benchmarks, and don't compare with other projects.

**Check.** Run `bun run lint:structure` and `bun run lint:md`, read the rendered diagram (paste it into a mermaid previewer or GitHub's preview), and make sure every command and code line in the README runs as written.

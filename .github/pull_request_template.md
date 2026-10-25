## What and why

<!-- What changes, and the problem it solves. Link the issue: "Fixes #123". -->

## How it was verified

<!-- Commands you ran and what they showed. For performance changes, the package's benchmark before and after, on the same machine. -->

## Checklist

- [ ] The title is a Conventional Commit, e.g. `fix(engine): keep pts when seeking raw H.264`
- [ ] `bun run check` and `bun test` pass, and the `code-reviewer` agent's findings are fixed
- [ ] Behaviour changes have a test whose expectation comes from an independent source, such as native `ffprobe`
- [ ] No assertion, tolerance or minimum is loosened to make a test pass; any changed expectation says here why the old one was wrong
- [ ] No coverage floor (`coverage-floor.json`) is lowered and no count in `tooling/lint-baseline.json` is raised, or this description says why
- [ ] `CHANGELOG.md` is updated for user-visible changes
- [ ] ffmpeg only: `dist.sha256` is updated if the build output changed
- [ ] Parts written by an AI agent are noted, and I have reviewed every line

<!-- markdownlint-configure-file { "MD043": { "headings": ["# Changelog", "## [Unreleased]", "*"] } } -->

# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `createAuthServer({ admit, end })`: an app decides whether the relay admits a connection whose token checks out, and is told when each connection closes, why, and how many bytes it moved through the relay, to apply its own limits and meter traffic ([Admission](docs/architecture.md#admission)). `authServer` admits every connection whose token checks out, as before.
- Edit-session grants (`signGrant`, `readGrant`, `verifyGrant`) and relay tokens (`editorToken`, `ownerToken`): the auth server lets a peer publish timeline batches and histories with `propose` and assets with `edit`, and tells `admit` each connection's `rights` and `grant`, so an agent leads to its person ([Rights and grants](docs/architecture.md#rights-and-grants)).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/logo-dark.svg">
  <img src="brand/logo.svg" alt="Snowy" height="64">
</picture>

[![ci](https://github.com/singh-pk/snowy-media/actions/workflows/ci.yml/badge.svg)](https://github.com/singh-pk/snowy-media/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@snowy-media/ffmpeg?label=%40snowy-media%2Fffmpeg)](https://www.npmjs.com/package/@snowy-media/ffmpeg)
[![Desktop Chromium](https://img.shields.io/badge/runs%20in-desktop%20Chromium-blue)](https://github.com/singh-pk/snowy-media/actions/workflows/ci.yml)
[![Types: TypeScript](https://img.shields.io/badge/types-TypeScript-3178C6)](packages/ffmpeg)
[![License: Snowy License and LGPL-2.1-or-later](https://img.shields.io/badge/license-Snowy%20License%20%2B%20LGPL--2.1--or--later-blue)](#licence)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/singh-pk/snowy-media/badge)](https://scorecard.dev/viewer/?uri=github.com/singh-pk/snowy-media)
[![REUSE compliant](https://img.shields.io/badge/REUSE-compliant-green)](https://reuse.software)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-FE5196)](https://www.conventionalcommits.org)

Snowy is a frontend-only media toolkit for the browser: a video player that plays every format, and later an editor, running entirely on the page with no server. This repository holds its packages, published on npm under `@snowy-media/`.

## Packages

| Package | What it is | Licence |
| --- | --- | --- |
| [`@snowy-media/engine`](packages/engine) | The playback pipeline: demuxing, decoding, an audio clock and WebGPU rendering in workers (in development) | [Snowy License](LICENSE.md) |
| [`@snowy-media/ffmpeg`](packages/ffmpeg) | FFmpeg 9 compiled to small, lazily loaded WebAssembly modules for demuxing and decoding | [LGPL-2.1-or-later](LICENSES/LGPL-2.1-or-later.txt) |
| [`@snowy-media/sync`](packages/sync) | Watch-together sessions: a local file streamed to a group, with shared chat and per-viewer audio and subtitles (in design) | [Snowy License](LICENSE.md) |
| [`@snowy-media/timeline`](packages/timeline) | The edit document of the editor: a magnetic timeline, its operations, and one linear history shared by every person and agent editing it (in design) | [Snowy License](LICENSE.md) |

Each package has its own README, documentation in `docs/` and CHANGELOG.

## Contributing

Issues and pull requests are welcome, from people and from AI agents. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; agents start at [AGENTS.md](AGENTS.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Licence

Snowy's packages are source-available under the [Snowy License](LICENSES/LicenseRef-Snowy-License-1.0.txt): free for individuals, companies of up to 3 people, non-profits, education, open-source projects and evaluation; larger companies using them in production need a company licence. `@snowy-media/ffmpeg` is [LGPL-2.1-or-later](LICENSES/LGPL-2.1-or-later.txt), like FFmpeg, and the repository tooling is [MIT](LICENSES/MIT.txt). [LICENSE.md](LICENSE.md) says what covers which files. The name and logos are trademarks ([TRADEMARKS.md](TRADEMARKS.md)).

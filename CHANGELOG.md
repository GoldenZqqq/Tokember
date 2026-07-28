# Changelog

All notable changes to Tokember will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
for public releases.

## [Unreleased]

### Added

- Built-in pricing catalog so a fresh install has real costs instead of an
  all-`unpriced` database, covering Anthropic models at their published rates.
  Upgrades pick up new models automatically and reprice historical `unpriced`
  rows, while any rule an operator created or edited is never overwritten.

### Changed

- Model breakdown now shows prompt-cache tokens and real totals beside input and
  output, so Claude-style cache traffic is no longer hidden behind a small
  “input” number.
- Certified Node.js 22.x (`>=22 <23`) as the development and release runtime;
  Node 24 remains unverified pending stable Windows default-worker E2E.
- Added weekly and pre-release Windows/macOS/Linux gates for the root verifier
  and real-platform Collector installer dry-runs, with Windows Chromium E2E.

## [0.2.0] - 2026-07-25

### Added

- English-default Web UI with an explicit, persisted English/Chinese language
  preference.
- Public GitHub Pages launch site with a reduced-motion-aware interactive furnace
  and product film.
- Browser coverage for the launch site across mobile, tablet, desktop, and wide
  viewports.

### Changed

- Refined device selection, source/model display names, mobile header controls,
  and responsive Dashboard/Settings layouts.
- Kept public pull-request verification focused on Linux quality, Chromium user
  journeys, and the production-matching arm64 container gate.

### Security

- Updated `@hono/node-server` to fix an unauthenticated WebSocket-handshake memory
  leak denial of service.
- Updated `postcss` to fix source-map path traversal and file disclosure.

## [0.1.0] - 2026-07-22

### Added

- Native collectors for **OpenClaw**, **Pi Agent**, and **Oh My Pi**.
- Public hygiene scan script: `node scripts/scan-public-hygiene.mjs`.
- Open-source governance docs: LICENSE (MIT), CONTRIBUTING, SECURITY,
  CODE_OF_CONDUCT, SUPPORT.
- Cross-platform collector installer entry (`collector/install.mjs`) with
  Windows Task Scheduler, macOS launchd, and Linux systemd user timer support
  (`install` / `upgrade` / `uninstall` / `doctor` / `collect` / `dry-run`).
- Public CI, Chromium E2E, arm64 container, Collector archive, GitHub Release,
  and multi-architecture GHCR distribution paths.

### Changed

- Collectors fail closed when `TOKEMBER_SERVER` or credentials are missing.
- Example configuration uses `https://tokember.example`.
- Local collector state defaults to `~/.tokember` and reuses `~/.ai-burn` when
  that is the only existing state.
- Development admin password fallback is the generic string `development`.
- Production deploy requires explicit CORS and Web target repository variables
  instead of personal domain or path defaults.

### Security

- Removed hard-coded production server URLs from Collector defaults and install
  templates.

## Earlier history

Pre-public development lived in a private monorepo. Public history starts from a
sanitized export of the first tagged open-source version.

[Unreleased]: https://github.com/GoldenZqqq/Tokember/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/GoldenZqqq/Tokember/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/GoldenZqqq/Tokember/releases/tag/v0.1.0

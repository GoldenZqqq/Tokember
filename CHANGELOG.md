# Changelog

All notable changes to Tokember will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
for public releases.

## [Unreleased]

### Added

- Native collectors for **OpenClaw**, **Pi Agent**, and **Oh My Pi**.
- Public hygiene scan script: `node scripts/scan-public-hygiene.mjs`.
- Open-source governance docs: LICENSE (MIT), CONTRIBUTING, SECURITY,
  CODE_OF_CONDUCT, SUPPORT.
- Cross-platform collector installer entry (`collector/install.mjs`) with
  Windows Task Scheduler, macOS launchd, and Linux systemd user timer support
  (`install` / `upgrade` / `uninstall` / `doctor` / `collect` / `dry-run`).
- Public CI matrix workflow (Ubuntu / Windows / macOS + arm64 container),
  separate from production deploy.

### Changed

- Collectors fail closed when `TOKEMBER_SERVER` or credentials are missing.
- Example configuration uses `https://tokember.example`.
- Local collector state defaults to `~/.tokember` (reuses `~/.ai-burn` when that
  is the only existing state).
- Development admin password fallback is the generic string `development`.
- Production deploy workflow requires explicit CORS and web target repository
  variables (no personal domain/path defaults).

### Security

- Removed hard-coded production server URLs from collector defaults and install
  templates.

## Earlier history

Pre-public development lived in a private monorepo. Public releases will start
numbering from the first tagged open-source version.

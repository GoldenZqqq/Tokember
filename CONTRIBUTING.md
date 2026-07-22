# Contributing to Tokember

Thanks for helping improve Tokember — a personal multi-device AI agent usage and
cost dashboard.

## Development setup

Requirements:

- Node.js 22+
- npm (repo uses `package-lock.json`)
- Python 3 for Hermes / Sub2API collector tests

```bash
npm ci
npm run verify
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run dev:server` | API server |
| `npm run dev:web` | Web dashboard |
| `npm run collect` | Native TypeScript collector |
| `npm run verify` | Full gate: typecheck, tests, build, dist smoke |

## Local collector configuration

Collectors **fail closed** without configuration:

```bash
export TOKEMBER_SERVER=https://tokember.example
export TOKEMBER_DEVICE_TOKEN=...   # preferred over shared API key
```

Never commit `collector/collector.env`, real device tokens, or production host
paths.

## Coding guidelines

- Prefer small, focused changes with tests.
- Collectors must not upload prompts, responses, absolute paths, or credentials.
- Device identity is a machine; tools are sources/providers under that device.
- Keep public examples on reserved domains (`tokember.example`), not personal hosts.

Project-specific contracts live under `.trellis/spec/` when developing inside
this monorepo.

## Pull requests

1. Run `npm run verify` (or the relevant workspace tests for a narrow change).
2. Describe what changed and how you validated it.
3. Note any schema, env, or collector state migration impact.
4. Do not include secrets, personal domains, or production inventory dumps.

## Versioning

Tokember aims for **SemVer** on public releases:

- **MAJOR** — breaking API / collector protocol / data migrations users must act on
- **MINOR** — backward-compatible features (new adapters, UI)
- **PATCH** — fixes and docs

## Security

Do not open public issues for vulnerabilities that include exploit detail.
See [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree your contributions are licensed under the MIT License
(see [LICENSE](./LICENSE)).

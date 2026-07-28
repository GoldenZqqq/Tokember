# Contributing to Tokember

Thanks for helping improve Tokember — a personal multi-device AI agent usage and
cost dashboard.

## Development setup

Requirements:

- Node.js 22.x (`>=22 <23`; Node 24 is not currently certified)
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
| `npm run verify` | Full gate: runtime/installer checks, typecheck, tests, build, dist smoke |

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

## Repository flow

The public repository is the contribution and distribution surface. During the
current transition, maintainers preserve a private source repository for product
and production operations, then publish product changes through a verified
allowlist export. Contributors do not need access to that private repository.

Open a normal public pull request and leave `PUBLIC_EXPORT.json` unchanged. A
maintainer will replay an accepted change into the source repository with
`Co-authored-by` attribution, run the full private gate, and publish a sync pull
request with the regenerated manifest. The original pull request will link to
the attributed commit and sync pull request before it is closed as superseded.

Direct public-only merges are reserved for urgent fixes. They freeze unrelated
public merges until the same patch has returned to the source repository and a
verified export reconciles `master`. See
[Repository governance](./docs/repository-governance.md) for the full contract.

## Pull requests

1. Run `npm run verify` (or the relevant workspace tests for a narrow change).
2. Describe what changed and how you validated it.
3. Note any schema, env, or collector state migration impact.
4. Do not include secrets, personal domains, or production inventory dumps.
5. Do not regenerate or hand-edit `PUBLIC_EXPORT.json` in a contribution PR.

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

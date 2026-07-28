# Compatibility matrix

Public Tokember releases document what is supported on day zero. Unsupported
tools are listed honestly rather than implied.

## Runtime

| Component | Requirement |
|-----------|-------------|
| Node.js | **22.x** (`>=22 <23`; collector + server tooling) |
| Python | **3.12+** only if you run Hermes companion scripts |
| SQLite | Bundled via `better-sqlite3` in Server images |

Node 24 is not currently certified because the Windows default-worker browser
gate is not stable there. Tokember rejects other Node majors before typecheck;
select Node 22 and rerun `npm ci` so native dependencies match its ABI.

## Operating systems (Collector installers)

| OS | Scheduler | Install entry |
|----|-----------|---------------|
| Windows 10+ | Task Scheduler (`tokember-collector`) | `node install.mjs install` |
| macOS 12+ | launchd user agent | same |
| Linux (systemd user) | `tokember-collector.timer` | same |

The public Release workflow verifies installer dry-runs on real Windows, macOS,
and Linux runners every week and before tag/manual packaging.

Upgrade without losing local env/state:

```bash
node install.mjs upgrade
```

## Server images

| Platform | Status |
|----------|--------|
| `linux/amd64` | Supported (Release + GHCR when configured) |
| `linux/arm64` | Supported (CI + Release) |

Image identity is recorded in `image-manifest.json` and Server `release.json`
(`version` + git commit + architecture + lockfile hash).

## Tool sources (activity)

| Source | Status | OS | Capability notes |
|--------|--------|----|------------------|
| Claude Code | Supported | Win / macOS / Linux | Native JSONL |
| Codex | Supported | Win / macOS / Linux | Native sessions |
| Grok Build | Supported | Win / macOS / Linux | `turn_completed` usage |
| Cursor | Supported | Win / macOS / Linux | Local DB |
| Gemini | Supported | Win / macOS / Linux | When installed |
| Cline / Roo | Supported | Win / macOS / Linux | VS Code globalStorage |
| Antigravity | Supported | Win / macOS / Linux | SQLite / RPC |
| Hermes | Supported | Linux primary | Python companion collector |
| OpenClaw | Supported | Win / macOS / Linux | Local state only: SQLite preferred + legacy JSONL; no remote gateway host |
| Pi Agent | Supported | Win / macOS / Linux | `~/.pi/agent/sessions` JSONL |
| Oh My Pi | Supported | Win / macOS / Linux | Same parser as Pi under `~/.omp/agent/sessions` |

Items not listed are **not yet** supported for automatic collection.

**OpenClaw / Pi verification:** unit fixtures cover parse, incremental, SQLite
prefer-over-JSONL, and missing-install soft success. Machines without a live
install skip these sources (`[]`) and do not block others. Optional live smoke:
set `OPENCLAW_STATE_DIR` / `PI_AGENT_SESSIONS_DIR` to a fixture tree or real
home state and run one `collect`.

Roadmap placeholders (honest “Not yet”): GitHub Copilot, Windsurf, OpenCode, and
similar IDE seats without a local usage ledger Tokember can read.

## Upgrade / rollback

- **Collector**: re-run `install.mjs upgrade` from a newer pack; default keeps
  `collector.env` and `~/.tokember` / `~/.ai-burn` state. `uninstall --purge`
  removes env/log only when explicitly requested.
- **Server (self-host)**: prefer immutable release directories / image tags;
  production host publish remains in private monorepo `deploy.yml`.
- **Protocol**: Server advertises `protocol` on `/api/health/live` and
  `/api/health/ready`. Collectors send `protocol_version` on register; mismatch
  returns **HTTP 426** with an upgrade hint. Day-0 window is **1**. See
  [data-lifecycle.md](./data-lifecycle.md).
- **Data**: ledger usage is not auto-purged; collector telemetry retains **90**
  days of detail with health anchors. Same-host backup/drill does not auto-
  restore DB on code rollback.

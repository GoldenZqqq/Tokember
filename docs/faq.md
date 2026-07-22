# FAQ

## Do I need every AI tool installed?

No. The Collector probes what is present and reports empty success for missing
tools. Install only the agents you use.

## Why is my device “degraded” / 异常 in Admin?

Usually one **tool source** failed or a sticky historical failure remains.
Open **Settings → Devices & Collectors**, expand sources, and read
`error_summary`. A successful full run clears healthy sources; runtime
registration failures are reported under the synthetic `collector` source.

## Collector says it is not configured

Set both:

- `TOKEMBER_SERVER` — your API base, no trailing slash required  
- `TOKEMBER_DEVICE_TOKEN` (preferred) or legacy `TOKEMBER_API_KEY`

Public builds do **not** default to any author’s hosted instance.

## First native run after using cc-switch

The Collector may perform a final legacy read and commit a per-device cutover.
That is expected; ledger history stays auditable on the Server.

## Adaptive schedule “skipped”

In `adaptive` mode, quiet machines skip full collect ticks (exit 0) until
activity or the next band. Use `node install.mjs collect` (forced) to run now.

## Docker healthcheck never becomes healthy

Check:

1. `TOKEMBER_API_KEY` and `TOKEMBER_ADMIN_PASSWORD` are set for the container.  
2. Build args `TOKEMBER_COMMIT` and `TOKEMBER_BUILT_AT` were provided.  
3. Logs: `docker logs tokember`.  
4. Ready probe: `http://127.0.0.1:3147/api/health/ready`.

## Is Sub2API / gateway spend included?

No. Gateway billing stays in the gateway’s own dashboard. Tokember focuses on
**agent-side** native activity.

## Where is local Collector state?

Default: `~/.tokember/`. If only legacy `~/.ai-burn/` exists, that path is
reused so cursors are not reset.

## How do I upgrade the Collector?

From a newer pack or git checkout:

```bash
node collector/install.mjs upgrade
# or: node install.mjs upgrade   # inside a release pack
```

Env and state are preserved unless you pass uninstall `--purge`.

## Protocol incompatible / HTTP 426

The Server rejected the Collector’s `protocol_version`. Check
`GET /api/health/ready` → `protocol`, upgrade the collector (or server) so both
sides share a window, then re-run collect. Details:
[data-lifecycle.md](./data-lifecycle.md).

## Will an upgrade wipe my usage history?

No. SQLite usage ledger is not auto-purged on upgrade. Collector telemetry keeps
about **90 days** of run detail for health. Code rollback does **not** restore
an older database automatically—back up the DB volume before risky changes.

## How do I uninstall?

```bash
node collector/install.mjs uninstall          # keep env + state
node collector/install.mjs uninstall --purge  # also remove env + log
```

## Windows: Task runs but nothing syncs

Run `node collector/install.mjs doctor`, then `collect`. Confirm Node ≥ 22 on
the PATH used by the scheduled task (installer pins an absolute `node.exe`).

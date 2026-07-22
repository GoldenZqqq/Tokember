# Data lifecycle, retention, and upgrade compatibility

How Tokember keeps usage data consistent across collector outages, server
upgrades, and day-to-day retention. This is the operator-facing map of
**what already ships** plus the **collector ↔ server protocol handshake**.

## Protocol version handshake

Collector and Server share an integer **`protocol_version`**. It is **not**
package semver and **not** the SQLite `schema_version`.

| Side | Day-0 value | Discovery |
|------|-------------|-----------|
| Server window | min = max = **1** | `GET /api/health/live` and `/api/health/ready` → `protocol` |
| Collector | sends **1** on `POST /api/devices` | Body field `protocol_version` |

### Rules

1. **Omitted** `protocol_version` on register is treated as **1** so older
   collectors keep working while the server min remains 1.
2. Outside `[min_protocol_version, max_protocol_version]` → **HTTP 426** with:

   ```json
   {
     "error": "protocol_incompatible",
     "client_protocol_version": 99,
     "min_protocol_version": 1,
     "max_protocol_version": 1,
     "upgrade_hint": "…"
   }
   ```

3. Raising server **min** is a breaking release: upgrade collectors **before**
   or **with** the server, and document in the release notes.

### Suggested upgrade order

```
1. Confirm recovery status healthy (same-host backup drill) if you run publish.
2. Deploy server that widens max (non-breaking) or raises min (breaking).
3. Check GET /api/health/ready → status ready + protocol window.
4. Upgrade collectors (install.mjs upgrade) when required by the window.
5. Confirm devices re-register and collector health is healthy/degraded (not offline).
```

## What data lives where

| Store | Contents | Retention (day-0) |
|-------|----------|-------------------|
| Server SQLite `usage_records` | Calls, tokens, cost, device/source keys | **No automatic purge** of the ledger in OSS day-0 |
| Server `collector_runs` / source runs | Run telemetry for Admin health | **90 days**, with anchors kept for latest success / watermarks |
| Server backups (`backups/periodic`) | Online Backup sets + restore drills | Default **28** successful sets after drill (recovery contract) |
| Collector `~/.tokember` (or legacy `~/.ai-burn`) | Checkpoints, adaptive locks, outbox | Survives `upgrade`; removed only with explicit purge |
| Collector outbox | Pending run reports until ack | Deleted only after server acknowledgement |

Usage **ledger** and **telemetry** are intentionally separate: pruning
collector runs must not change Calls / Tokens / Cost totals.

## Export and audit

- Admin audit export: `GET /api/admin/audit/export?format=json|csv` with a
  time window (authenticated Admin session).
- Dashboard drilldown / records APIs are snapshot-bound; see audit contracts
  in the monorepo specs if you extend exports.
- **Import** of a full ledger dump is **not** a day-0 public feature. Treat
  recovery as restore-from-backup + re-collect, not free-form merge.

## Same-host backup and rollback

Production host tooling (private deploy path) uses:

- Online Backup + integrity + restore **drill** (no production bind, no secret
  replay).
- Atomic release directories and `current` symlink for **code/static** rollback.
- **Never** automatically overwrite the live DB on code rollback. Schema
  incompatibility needs a reviewed maintenance decision.

Public Docker / Release users should still:

1. Back up the SQLite volume (or host DB path) before major upgrades.
2. Prefer image tags / immutable trees over in-place mutation.
3. Verify `/api/health/ready` after cutover.

Details: recovery and release contracts under `.trellis/spec/server/backend/`
when working in the monorepo.

## Collector offline / outbox consistency

1. A run is recorded locally; reports queue if the server is unreachable.
2. Flush retries until the server returns a valid run acknowledgement.
3. Only **acknowledged** reports are removed from the outbox.
4. Checkpoints advance only with successful ingest acknowledgement rules
   (atomic ingest contract)—never on a mere HTTP timeout.

So temporary server downtime should not invent duplicate ledger rows when
dedup keys are stable; unacked outbox remains until success.

## Operator preflight checklist

| Check | How |
|-------|-----|
| Node runtime | Collector: Node ≥ 22; `node install.mjs doctor` |
| Server auth / DB | `GET /api/health/ready` → all `checks` true in production |
| Protocol window | Same response → `protocol.min/max` |
| Device credential | Admin-issued device token matches `TOKEMBER_DEVICE_*` |
| Scheduler | doctor / OS task / systemd user timer present |
| Backup (self-host) | recovery status not `stale` / failed before publish |
| Architecture | Publish rejects host arch ≠ build arch |

## Related docs

- [COMPATIBILITY.md](./COMPATIBILITY.md) — OS, Node, tool matrix
- [privacy.md](./privacy.md) — what is uploaded
- [release.md](./release.md) — packaging and GitHub Releases
- [faq.md](./faq.md) — common failures

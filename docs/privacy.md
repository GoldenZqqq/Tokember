# Privacy

Tokember is **self-hosted**. Your usage ledger stays on **your** Server and
SQLite database unless **you** choose to back it up elsewhere.

## What Collectors upload

Only **usage / telemetry aggregates** needed for cost and health:

| Uploaded | Examples |
|----------|----------|
| Token counters | input, output, cache read/create, reasoning (when the tool reports them) |
| Cost when the tool provides it | vendor `cost_usd` / equivalent |
| Model and provider labels | e.g. `claude`, `codex`, model id |
| Timestamps and request counts | for trends and dedup |
| Device identity | device id / name you configured |
| Optional attribution **hashes** | only if you enable project/session attribution |
| Collector run health | scan/upload counters, watermarks, error **summaries** (redacted) |

## What Collectors never upload

| Not uploaded | Notes |
|--------------|--------|
| Prompts / completions / code | Never read for billing upload |
| Absolute filesystem paths | Stripped; attribution uses local HMAC seeds |
| Usernames, emails, repo URLs | Not part of the wire format |
| API keys for third-party AI providers | Collectors read **local** tool logs/DBs only |
| Full tool session transcripts | Only completed-turn usage records |
| Raw secrets in logs | Errors are sanitized before run reports |

Project/session attribution is **off by default**. When enabled, only
source-native stable ids are hashed locally with a machine secret that is
**never** uploaded.

## Network boundary

```
[ AI tools on your machine ]
        │ read local logs / DBs only
        ▼
[ Tokember Collector ]
        │ HTTPS to YOUR server only
        ▼
[ Tokember Server + SQLite ]  ← you control retention & backups
```

- Collectors **fail closed** if `TOKEMBER_SERVER` or credentials are missing.
- There is **no** default production URL in public builds (example:
  `https://tokember.example`).
- Shared billing gateways (e.g. Sub2API) are **not** mixed into agent activity
  totals.

## Admin and Viewer data

- Admin sessions can see usage, devices, pricing rules, and health aggregates.
- Optional Viewer password protects dashboard reads without granting admin.
- Recovery status exposed in Admin is an **aggregate** (healthy/stale/failed),
  not raw backup paths or DB rows.

## Your responsibilities

1. Keep `collector.env` and device tokens off git and public chats.
2. Point collectors only at servers you trust.
3. Use reverse-proxy TLS in production.
4. Treat SQLite backups as sensitive (they contain usage history).

#!/usr/bin/env python3
"""Sync authoritative Sub2API usage logs to a Tokember server."""

from __future__ import annotations

import csv
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

# One logical gateway device for all consumer API keys.
SUB2API_DEVICE_ID = "sub2api"
SUB2API_DEVICE_NAME = "sub2api"


@dataclass(frozen=True)
class Config:
    server_url: str
    api_key: str
    state_path: Path
    docker_bin: str
    postgres_container: str
    postgres_user: str
    postgres_db: str
    batch_size: int
    start_id: int


def env_int(name: str, default: int) -> int:
    value = int(os.getenv(name, str(default)))
    if value < 0:
        raise ValueError(f"{name} must be non-negative")
    return value


def env_value(primary: str, legacy: str, default: str = "") -> str:
    return os.getenv(primary) or os.getenv(legacy) or default


def preferred_state_path(canonical: Path, legacy: Path) -> Path:
    return legacy if legacy.exists() and not canonical.exists() else canonical


def load_config() -> Config:
    configured_state = env_value("TOKEMBER_SUB2API_STATE", "SUB2API_STATE")
    return Config(
        server_url=env_value(
            "TOKEMBER_SERVER", "AI_BURN_SERVER"
        ).rstrip("/"),
        api_key=(
            env_value("TOKEMBER_API_KEY", "AI_BURN_API_KEY")
            or os.getenv("API_KEY")
            or ""
        ).strip(),
        state_path=Path(configured_state) if configured_state else preferred_state_path(
            Path("/var/lib/tokember-sub2api/state.json"),
            Path("/var/lib/ai-burn-sub2api/state.json"),
        ),
        docker_bin=os.getenv("SUB2API_DOCKER_BIN", "/usr/bin/docker"),
        postgres_container=os.getenv("SUB2API_POSTGRES_CONTAINER", "sub2api-postgres"),
        postgres_user=os.getenv("SUB2API_POSTGRES_USER", "sub2api"),
        postgres_db=os.getenv("SUB2API_POSTGRES_DB", "sub2api"),
        batch_size=max(1, env_int("SUB2API_BATCH_SIZE", 500)),
        start_id=env_int("SUB2API_START_ID", 0),
    )


def load_last_id(path: Path, default: int = 0) -> int:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return max(int(data.get("last_id", 0)), 0)
    except FileNotFoundError:
        return default


def save_last_id(path: Path, last_id: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"version": 1, "last_id": last_id}), encoding="utf-8")
    os.replace(temporary, path)


def query_sql(last_id: int, batch_size: int) -> str:
    return f"""
        SELECT u.id, u.api_key_id, k.name AS api_key_name, u.model,
               u.input_tokens, u.output_tokens, u.cache_read_tokens,
               u.cache_creation_tokens, u.actual_cost, u.created_at,
               u.ip_address
        FROM usage_logs u
        JOIN api_keys k ON k.id = u.api_key_id
        WHERE u.id > {last_id}
        ORDER BY u.id
        LIMIT {batch_size}
    """


def query_rows(config: Config, last_id: int) -> list[dict[str, str]]:
    command = [
        config.docker_bin, "exec", config.postgres_container, "psql",
        "-U", config.postgres_user, "-d", config.postgres_db,
        "--csv", "-c", query_sql(last_id, config.batch_size),
    ]
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    return list(csv.DictReader(StringIO(result.stdout)))


def device_id() -> str:
    return SUB2API_DEVICE_ID


def device_name() -> str:
    """Single gateway label. Never use consumer API key names."""
    return SUB2API_DEVICE_NAME


def heartbeat_device(config: Config) -> None:
    post_json(
        config.server_url,
        "/api/devices",
        {"id": device_id(), "name": device_name()},
        config.api_key,
    )


def as_int(row: dict[str, str], name: str) -> int:
    return int(row.get(name) or 0)


def normalize_timestamp(value: str) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def row_to_record(row: dict[str, str]) -> dict[str, Any]:
    usage_id = as_int(row, "id")
    api_key_id = as_int(row, "api_key_id")
    return {
        "provider": "sub2api",
        "model": row.get("model") or "unknown",
        "request_count": 1,
        "input_tokens": as_int(row, "input_tokens"),
        "output_tokens": as_int(row, "output_tokens"),
        "cache_read_tokens": as_int(row, "cache_read_tokens"),
        "cache_creation_tokens": as_int(row, "cache_creation_tokens"),
        "reasoning_tokens": 0,
        "input_includes_cache_read": False,
        "input_includes_cache_creation": False,
        "output_includes_reasoning": False,
        "cost_usd": float(row.get("actual_cost") or 0),
        "cost_provided": True,
        "timestamp": normalize_timestamp(row["created_at"]),
        "source_file": f"sub2api:key:{api_key_id}",
        "dedup_key": f"sub2api:usage:{usage_id}",
    }


def post_json(server_url: str, path: str, payload: dict[str, Any], api_key: str = "") -> dict[str, Any]:
    headers = {"Content-Type": "application/json", "User-Agent": "tokember-sub2api/0.1"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = Request(
        f"{server_url}{path}",
        data=json.dumps(payload, separators=(",", ":")).encode(),
        headers=headers,
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def is_count(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def ingest_changed_count(result: Any, batch_size: int) -> int:
    if not isinstance(result, dict):
        raise ValueError("invalid ingest acknowledgement")
    exact_fields = ("created", "updated", "unchanged", "total")
    if any(field in result for field in exact_fields):
        counts = [result.get(field) for field in (*exact_fields, "inserted")]
        if result.get("ok") is not True or not all(is_count(value) for value in counts):
            raise ValueError("invalid ingest acknowledgement")
        created, updated, unchanged, total, inserted = counts
        if total != batch_size:
            raise ValueError("partial ingest acknowledgement")
        if total != created + updated + unchanged or inserted != created + updated:
            raise ValueError("invalid ingest acknowledgement")
        return inserted
    inserted = result.get("inserted")
    if ("ok" in result and result.get("ok") is not True) or not is_count(inserted):
        raise ValueError("invalid ingest acknowledgement")
    if inserted > batch_size:
        raise ValueError("invalid ingest acknowledgement")
    return inserted


def sync_rows(config: Config, rows: list[dict[str, str]]) -> int:
    """Register the single gateway device and ingest all rows under it."""
    post_json(
        config.server_url,
        "/api/devices",
        {"id": device_id(), "name": device_name()},
        config.api_key,
    )
    records = [row_to_record(row) for row in rows]
    changed = 0
    for start in range(0, len(records), 500):
        batch = records[start : start + 500]
        result = post_json(
            config.server_url,
            "/api/ingest",
            {"device_id": device_id(), "records": batch},
            config.api_key,
        )
        changed += ingest_changed_count(result, len(batch))
    return changed


def main() -> int:
    config = load_config()
    last_id = load_last_id(config.state_path, config.start_id)
    total_changed = 0
    if not config.server_url:
        raise SystemExit(
            "Collector is not configured: set TOKEMBER_SERVER "
            "(example https://tokember.example)"
        )
    if not config.api_key:
        raise SystemExit(
            "Collector is not configured: set TOKEMBER_API_KEY "
            "(or TOKEMBER_DEVICE_TOKEN-compatible bearer)"
        )
    total_seen = 0
    print(f"[Tokember sub2api] server={config.server_url} last_id={last_id}")

    while True:
        rows = query_rows(config, last_id)
        if not rows:
            break
        changed = sync_rows(config, rows)
        last_id = max(as_int(row, "id") for row in rows)
        save_last_id(config.state_path, last_id)
        total_changed += changed
        total_seen += len(rows)
        if len(rows) < config.batch_size:
            break

    # Empty batches previously skipped /api/devices, so admin "online" went stale
    # even while the timer kept succeeding. Always heartbeat the single gateway.
    if total_seen == 0:
        heartbeat_device(config)
        print(f"Heartbeat: 1 device, 0 source rows, last_id={last_id}")
    else:
        print(
            f"Synced: {total_changed} changed, {total_seen} source rows, last_id={last_id}"
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Sub2API collector failed: {error}", file=sys.stderr)
        raise SystemExit(1)

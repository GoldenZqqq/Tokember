#!/usr/bin/env python3
"""Sync aggregate Hermes sessions to a Tokember server."""

from __future__ import annotations

import hashlib
import json
import os
import platform as runtime_platform
import re
import socket
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from time import monotonic
from typing import Any
from urllib.request import Request, urlopen

try:
    import hermes_attribution as _attribution
    import hermes_outbox as _outbox
except ModuleNotFoundError:
    from collector import hermes_attribution as _attribution
    from collector import hermes_outbox as _outbox

load_or_create_secret = _attribution.load_or_create_secret
empty_outbox = _outbox.empty_outbox
load_outbox = _outbox.load_outbox
save_outbox = _outbox.save_outbox


def env_value(primary: str, legacy: str, default: str = "") -> str:
    return os.getenv(primary) or os.getenv(legacy) or default


def positive_float_env(primary: str, legacy: str, default: float) -> float:
    raw = env_value(primary, legacy, str(default))
    try:
        value = float(raw)
    except ValueError as error:
        raise ValueError(f"{primary} must be a positive number") from error
    if value <= 0:
        raise ValueError(f"{primary} must be a positive number")
    return value


def preferred_state_path(canonical: Path, legacy: Path) -> Path:
    return legacy if legacy.exists() and not canonical.exists() else canonical


SERVER_URL = env_value("TOKEMBER_SERVER", "AI_BURN_SERVER").rstrip("/")


def configured_auth_token() -> str:
    return (
        os.getenv("TOKEMBER_DEVICE_TOKEN")
        or env_value("TOKEMBER_API_KEY", "AI_BURN_API_KEY")
        or os.getenv("API_KEY")
        or ""
    ).strip()


AUTH_TOKEN = configured_auth_token()


def assert_collector_target() -> None:
    """Fail closed before any network write when the target is incomplete."""
    if not SERVER_URL:
        raise SystemExit(
            "Collector is not configured: set TOKEMBER_SERVER "
            "(example https://tokember.example)"
        )
    if not AUTH_TOKEN:
        raise SystemExit(
            "Collector is not configured: set TOKEMBER_DEVICE_TOKEN "
            "(preferred) or TOKEMBER_API_KEY"
        )
DB_PATH = os.path.expanduser(
    os.getenv("HERMES_DB", "~/.hermes/state.db")
)
INSTANCE_ID = os.getenv("HERMES_INSTANCE_ID", socket.gethostname())
DEVICE_ID = env_value(
    "TOKEMBER_DEVICE_ID",
    "AI_BURN_DEVICE_ID",
    hashlib.md5(socket.gethostname().encode(), usedforsecurity=False).hexdigest()[:12],
)
DEVICE_NAME = env_value("TOKEMBER_DEVICE_NAME", "AI_BURN_DEVICE_NAME", socket.gethostname())
CONFIGURED_STATE_PATH = env_value("TOKEMBER_STATE", "AI_BURN_STATE")
STATE_PATH = Path(CONFIGURED_STATE_PATH) if CONFIGURED_STATE_PATH else preferred_state_path(
    Path("/var/lib/tokember-hermes/state.json"),
    Path("/var/lib/ai-burn-hermes/state.json"),
)
ATTRIBUTION_SECRET_PATH = Path(env_value(
    "TOKEMBER_ATTRIBUTION_SECRET_FILE",
    "AI_BURN_ATTRIBUTION_SECRET_FILE",
    str(STATE_PATH.parent / "attribution-secret"),
))
COUNTER_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
    "api_call_count",
)
DEFAULT_BOOTSTRAP_HOURS = 48.0
COLLECTOR_VERSION = "0.1.0"
DEFAULT_SCHEDULE_INTERVAL_MINUTES = 60
MAX_PENDING_REPORTS = 100
MAX_ERROR_LENGTH = 500


def positive_int_env(primary: str, legacy: str, default: int) -> int:
    raw = env_value(primary, legacy, str(default))
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError(f"{primary} must be an integer between 1 and 10080") from error
    if value < 1 or value > 10080:
        raise ValueError(f"{primary} must be an integer between 1 and 10080")
    return value


def observability_path() -> Path:
    configured = env_value("TOKEMBER_OBSERVABILITY_STATE", "AI_BURN_OBSERVABILITY_STATE")
    return Path(configured) if configured else Path(
        "/var/lib/tokember-hermes/observability.json"
    )


def post_json(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(payload, separators=(",", ":")).encode()
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "tokember-hermes/0.1",
    }
    if AUTH_TOKEN:
        headers["Authorization"] = f"Bearer {AUTH_TOKEN}"
    request = Request(
        f"{SERVER_URL}{path}",
        data=body,
        headers=headers,
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def epoch_to_iso(value: float | int | None) -> str:
    timestamp = float(value or 0)
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace(
        "+00:00", "Z"
    )


def effective_cost(row: sqlite3.Row) -> float:
    actual = row["actual_cost_usd"]
    estimated = row["estimated_cost_usd"]
    if actual is not None:
        return float(actual)
    return float(estimated or 0)


def snapshot_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "model": row["model"] or "unknown",
        "billing_provider": row["billing_provider"] or "unknown",
        "cost_status": row["cost_status"] or "unknown",
        "activity_at": row["activity_at"] or row["ended_at"] or row["started_at"],
        "cost_usd": effective_cost(row),
        **{field: int(row[field] or 0) for field in COUNTER_FIELDS},
    }


def collect_snapshots(db_path: str = DB_PATH) -> dict[str, dict[str, Any]]:
    uri = f"file:{os.path.abspath(db_path)}?mode=ro"
    db = sqlite3.connect(uri, uri=True)
    try:
        db.row_factory = sqlite3.Row
        rows = db.execute(
            """
            SELECT s.id, s.model, s.started_at, s.ended_at,
                   s.input_tokens, s.output_tokens,
                   s.cache_read_tokens, s.cache_write_tokens, s.reasoning_tokens,
                   s.billing_provider, s.estimated_cost_usd, s.actual_cost_usd,
                   s.cost_status, s.api_call_count, MAX(m.timestamp) activity_at
            FROM sessions s
            LEFT JOIN messages m ON m.session_id = s.id
            GROUP BY s.id
            ORDER BY s.started_at
            """
        ).fetchall()
    finally:
        db.close()
    snapshots = [snapshot_from_row(row) for row in rows]
    return {snapshot["id"]: snapshot for snapshot in snapshots}


def load_state(path: Path = STATE_PATH) -> dict[str, dict[str, Any]] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data.get("sessions", {})
    except FileNotFoundError:
        return None


def save_state(sessions: dict[str, dict[str, Any]], path: Path = STATE_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"version": 1, "sessions": sessions}), encoding="utf-8")
    os.replace(temporary, path)


def build_delta_record(
    current: dict[str, Any], previous: dict[str, Any],
    attribution: tuple[bool, str | None] | None = None,
) -> dict[str, Any] | None:
    delta = {field: max(current[field] - int(previous.get(field, 0)), 0) for field in COUNTER_FIELDS}
    cost_delta = max(current["cost_usd"] - float(previous.get("cost_usd", 0)), 0)
    token_delta = sum(delta[field] for field in COUNTER_FIELDS if field != "api_call_count")
    if token_delta == 0 and cost_delta == 0 and delta["api_call_count"] == 0:
        return None
    fingerprint = create_snapshot_hash(current)
    enabled, secret = attribution or _attribution.attribution_context(ATTRIBUTION_SECRET_PATH)
    fields = {
        "attribution_version": 1,
        "attribution_status": "captured" if enabled else "disabled",
    }
    if enabled and secret:
        fields["session_id"] = _attribution.anonymous_id(
            "session", "hermes", str(current["id"]), secret
        )
    return {
        "provider": "hermes",
        "model": current["model"],
        "request_count": delta["api_call_count"],
        "input_tokens": delta["input_tokens"],
        "output_tokens": delta["output_tokens"],
        "cache_read_tokens": delta["cache_read_tokens"],
        "cache_creation_tokens": delta["cache_write_tokens"],
        "reasoning_tokens": delta["reasoning_tokens"],
        "input_includes_cache_read": False,
        "input_includes_cache_creation": False,
        "output_includes_reasoning": False,
        "cost_usd": cost_delta,
        "timestamp": epoch_to_iso(current["activity_at"]),
        "source_file": f"hermes-delta:{current['billing_provider']}:{current['cost_status']}",
        "dedup_key": f"hermes-delta:{INSTANCE_ID}:{current['id']}:{fingerprint}",
        **fields,
    }


def create_snapshot_hash(snapshot: dict[str, Any]) -> str:
    payload = {field: snapshot[field] for field in (*COUNTER_FIELDS, "cost_usd")}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]


def build_delta_records(current: dict[str, dict[str, Any]], previous: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    records = []
    attribution = _attribution.attribution_context(ATTRIBUTION_SECRET_PATH)
    for session_id, snapshot in current.items():
        old = previous.get(session_id, {field: 0 for field in (*COUNTER_FIELDS, "cost_usd")})
        record = build_delta_record(snapshot, old, attribution)
        if record:
            records.append(record)
    return records


def build_bootstrap_records(
    current: dict[str, dict[str, Any]],
    now_epoch: float | None = None,
    bootstrap_hours: float | None = None,
) -> list[dict[str, Any]]:
    hours = bootstrap_hours if bootstrap_hours is not None else positive_float_env(
        "TOKEMBER_HERMES_BOOTSTRAP_HOURS",
        "AI_BURN_HERMES_BOOTSTRAP_HOURS",
        DEFAULT_BOOTSTRAP_HOURS,
    )
    now = now_epoch if now_epoch is not None else datetime.now(timezone.utc).timestamp()
    cutoff = now - hours * 3600
    recent = {
        session_id: snapshot
        for session_id, snapshot in current.items()
        if float(snapshot.get("activity_at") or 0) >= cutoff
    }
    return build_delta_records(recent, {})


def register_device() -> None:
    system = runtime_platform.system().lower()
    platform_name = {
        "windows": "windows",
        "darwin": "macos",
        "linux": "linux",
    }.get(system, "other")
    post_json("/api/devices", {
        "id": DEVICE_ID,
        "name": DEVICE_NAME,
        "platform": platform_name,
        "architecture": runtime_platform.machine() or "unknown",
        "hostname": socket.gethostname(),
    })


def is_count(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def ingest_acknowledgement(result: Any, batch_size: int) -> tuple[int, int]:
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
        return inserted, unchanged
    inserted = result.get("inserted")
    if ("ok" in result and result.get("ok") is not True) or not is_count(inserted):
        raise ValueError("invalid ingest acknowledgement")
    if inserted > batch_size:
        raise ValueError("invalid ingest acknowledgement")
    return inserted, batch_size - inserted


def ingest(records: list[dict[str, Any]]) -> int:
    accepted = 0
    for start in range(0, len(records), 500):
        batch = records[start : start + 500]
        result = post_json(
            "/api/ingest",
            {"device_id": DEVICE_ID, "records": batch},
        )
        batch_accepted, _ = ingest_acknowledgement(result, len(batch))
        accepted += batch_accepted
    return accepted


def sanitize_error(error: Any) -> str:
    message = str(error or "unknown failure")
    message = re.sub(
        r"authorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+",
        "Authorization: [redacted]",
        message,
        flags=re.IGNORECASE,
    )
    message = re.sub(r"\bbearer\s+[^\s,;]+", "Bearer [redacted]", message, flags=re.IGNORECASE)
    message = re.sub(
        r"\bx-api-key\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)",
        "X-API-Key: [redacted]",
        message,
        flags=re.IGNORECASE,
    )
    message = re.sub(
        r"\b(TOKEMBER_DEVICE_TOKEN|TOKEMBER_API_KEY|AI_BURN_API_KEY|API_KEY)\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)",
        r"\1=[redacted]",
        message,
        flags=re.IGNORECASE,
    )
    message = re.sub(
        r"\btkdc_[A-Za-z0-9_-]{12,64}_[A-Za-z0-9_-]{32,128}\b",
        "[device-token]",
        message,
    )
    message = re.sub(r"\b[A-Za-z]:[\\/][^\s,;]+", "[path]", message)
    message = re.sub(r"\\\\[^\\\s]+\\[^\s,;]+", "[path]", message)
    message = re.sub(r"/(?:home|Users|var/lib|tmp|opt)/[^\s,;]+", "[path]", message)
    return " ".join(message.split())[:MAX_ERROR_LENGTH] or "unknown failure"


def latest_record_time(records: list[dict[str, Any]]) -> str | None:
    values = [record.get("timestamp") for record in records]
    parsed = [value for value in values if isinstance(value, str)]
    return max(parsed) if parsed else None


def snapshot_watermark(snapshots: dict[str, dict[str, Any]]) -> str | None:
    values = [float(snapshot.get("activity_at") or 0) for snapshot in snapshots.values()]
    return epoch_to_iso(max(values)) if values and max(values) > 0 else None


def new_run_start(now: datetime | None = None, run_id: str | None = None) -> dict[str, Any]:
    started = now or datetime.now(timezone.utc)
    return {
        "schema_version": 1,
        "run_id": run_id or str(uuid.uuid4()),
        "device_id": DEVICE_ID,
        "collector_kind": "hermes",
        "collector_version": COLLECTOR_VERSION,
        "schedule_interval_minutes": positive_int_env(
            "TOKEMBER_SCHEDULE_INTERVAL_MINUTES",
            "AI_BURN_SCHEDULE_INTERVAL_MINUTES",
            DEFAULT_SCHEDULE_INTERVAL_MINUTES,
        ),
        "started_at": started.isoformat().replace("+00:00", "Z"),
    }


COLLECTOR_RUNTIME_SOURCE = "collector"


def successful_collector_runtime_source(duration_ms: int = 0) -> dict[str, Any]:
    return {
        "source": COLLECTOR_RUNTIME_SOURCE,
        "status": "success",
        "discovered": 0,
        "scanned": 0,
        "emitted": 0,
        "accepted": 0,
        "unchanged": 0,
        "watermark_at": None,
        "last_usage_at": None,
        "duration_ms": max(0, duration_ms),
        "error_summary": None,
    }


def with_collector_runtime_success(sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Append collector runtime success so a sticky registration failure clears."""
    if any(source.get("source") == COLLECTOR_RUNTIME_SOURCE for source in sources):
        return sources
    if sources and not all(source.get("status") == "success" for source in sources):
        return sources
    return [*sources, successful_collector_runtime_source()]


def build_run_report(
    start: dict[str, Any], sources: list[dict[str, Any]], finished: datetime | None = None
) -> dict[str, Any]:
    finished_at = finished or datetime.now(timezone.utc)
    reported = with_collector_runtime_success(sources)
    successful = sum(source["status"] == "success" for source in reported)
    status = "success" if successful == len(reported) else "failed" if successful == 0 else "partial"
    all_known = all(source["accepted"] is not None for source in reported)
    errors = [
        f"{source['source']}: {source['error_summary']}"
        for source in reported if source["error_summary"]
    ]
    started_at = datetime.fromisoformat(start["started_at"].replace("Z", "+00:00"))
    return {
        **start,
        "finished_at": finished_at.isoformat().replace("+00:00", "Z"),
        "status": status,
        "duration_ms": max(0, int((finished_at - started_at).total_seconds() * 1000)),
        "emitted": sum(source["emitted"] for source in reported),
        "accepted": sum(source["accepted"] for source in reported) if all_known else None,
        "unchanged": sum(source["unchanged"] for source in reported) if all_known else None,
        "error_summary": sanitize_error("; ".join(errors)) if errors else None,
        "sources": reported,
    }


def failed_source(
    source: str, error: Any, *, discovered: int = 0, scanned: int = 0,
    emitted: int = 0, status: str = "collection_failed", duration_ms: int = 0,
) -> dict[str, Any]:
    return {
        "source": source,
        "status": status,
        "discovered": discovered,
        "scanned": scanned,
        "emitted": emitted,
        "accepted": None,
        "unchanged": None,
        "watermark_at": None,
        "last_usage_at": None,
        "duration_ms": max(0, duration_ms),
        "error_summary": sanitize_error(error),
    }


def failed_run_report(
    start: dict[str, Any], error: Any, finished: datetime | None = None
) -> dict[str, Any]:
    return build_run_report(start, [failed_source("collector", error)], finished)


def recover_and_begin_run(start: dict[str, Any], path: Path) -> None:
    started = datetime.fromisoformat(start["started_at"].replace("Z", "+00:00"))
    _outbox.recover_and_begin_run(start, path, MAX_PENDING_REPORTS, lambda run: failed_run_report(
        run, "Collector terminated before completion", started,
    ))


def finish_pending_run(report: dict[str, Any], path: Path) -> None:
    _outbox.finish_pending_run(report, path, MAX_PENDING_REPORTS)


def report_run(report: dict[str, Any]) -> None:
    result = post_json("/api/collector-runs", report)
    if result.get("ok") is not True or result.get("run_id") != report["run_id"]:
        raise ValueError("invalid collector run acknowledgement")


def flush_pending_runs(path: Path) -> int:
    return _outbox.flush_pending_runs(path, report_run)


def safe_begin_run(start: dict[str, Any], path: Path) -> None:
    try:
        recover_and_begin_run(start, path)
    except Exception as error:
        print(f"Telemetry start persistence failed: {sanitize_error(error)}", file=sys.stderr)


def safe_finish_run(report: dict[str, Any], path: Path) -> bool:
    try:
        finish_pending_run(report, path)
        return True
    except Exception as error:
        print(f"Telemetry queue failed: {sanitize_error(error)}", file=sys.stderr)
        return False


def safe_flush_runs(path: Path) -> None:
    try:
        sent = flush_pending_runs(path)
        if sent:
            print(f"Telemetry: {sent} run report(s) acknowledged")
    except Exception as error:
        print(f"Telemetry flush deferred: {sanitize_error(error)}", file=sys.stderr)


def successful_hermes_source(
    snapshots: dict[str, dict[str, Any]], records: list[dict[str, Any]], *,
    accepted: int, unchanged: int, duration_ms: int,
) -> dict[str, Any]:
    return {
        "source": "hermes",
        "status": "success",
        "discovered": len(snapshots),
        "scanned": len(snapshots),
        "emitted": len(records),
        "accepted": accepted,
        "unchanged": unchanged,
        "watermark_at": snapshot_watermark(snapshots),
        "last_usage_at": latest_record_time(records),
        "duration_ms": max(0, duration_ms),
        "error_summary": None,
    }


def failure_sources(
    phase: str, error: Exception, *, snapshots: dict[str, dict[str, Any]],
    records: list[dict[str, Any]], source: dict[str, Any] | None, source_started: float,
) -> list[dict[str, Any]]:
    if phase == "state" and source is not None:
        state_error = failed_source("collector-state", error)
        state_error["accepted"] = 0
        state_error["unchanged"] = 0
        return [source, state_error]
    source_name = "collector" if phase == "registration" else "hermes"
    status = "upload_failed" if phase == "upload" else "collection_failed"
    failed = failed_source(
        source_name, error, discovered=len(snapshots), scanned=len(snapshots),
        emitted=len(records), status=status,
        duration_ms=int((monotonic() - source_started) * 1000),
    )
    failed["watermark_at"] = snapshot_watermark(snapshots)
    failed["last_usage_at"] = latest_record_time(records)
    return [failed]


def print_sync_result(
    previous: dict[str, dict[str, Any]] | None, accepted: int, *,
    records: list[dict[str, Any]], snapshots: dict[str, dict[str, Any]],
) -> None:
    if previous is None:
        print(
            f"Bootstrap synced: {accepted} changed records out of {len(records)} "
            f"recent sessions; baseline saved for {len(snapshots)} sessions"
        )
    else:
        print(f"Synced: {accepted} changed records out of {len(records)} session deltas")


def finish_run_telemetry(report: dict[str, Any], path: Path, registered: bool) -> None:
    queued = safe_finish_run(report, path)
    if not registered:
        return
    if queued:
        safe_flush_runs(path)
        return
    try:
        report_run(report)
    except Exception:
        pass


def begin_hermes_run(report_telemetry: bool, outbox: Path | None) -> tuple[dict[str, Any], Path]:
    print(f"[Tokember hermes] device={DEVICE_NAME} ({DEVICE_ID})")
    print(f"[Tokember hermes] server={SERVER_URL}")
    start = new_run_start()
    path = outbox or observability_path()
    if report_telemetry:
        safe_begin_run(start, path)
    return start, path

def main(report_telemetry: bool = False, outbox: Path | None = None) -> int:
    start, path = begin_hermes_run(report_telemetry, outbox)
    snapshots: dict[str, dict[str, Any]] = {}
    records: list[dict[str, Any]] = []
    source: dict[str, Any] | None = None
    phase = "collection"
    source_started = monotonic()
    registered = False
    failure: Exception | None = None
    try:
        snapshots = collect_snapshots()
        phase = "registration"
        register_device()
        registered = True
        if report_telemetry:
            safe_flush_runs(path)
        previous = load_state()
        records = (
            build_bootstrap_records(snapshots)
            if previous is None
            else build_delta_records(snapshots, previous)
        )
        phase = "upload"
        accepted = ingest(records)
        source = successful_hermes_source(
            snapshots, records, accepted=accepted, unchanged=len(records) - accepted,
            duration_ms=int((monotonic() - source_started) * 1000),
        )
        phase = "state"
        save_state(snapshots)
        print_sync_result(previous, accepted, records=records, snapshots=snapshots)
    except Exception as error:
        failure = error
        sources = failure_sources(
            phase, error, snapshots=snapshots, records=records,
            source=source, source_started=source_started,
        )
    else:
        sources = [source] if source is not None else [
            failed_source("collector", "missing Hermes source result")
        ]
    report = build_run_report(start, sources)
    if report_telemetry:
        finish_run_telemetry(report, path, registered)
    if failure:
        raise failure
    return 0

if __name__ == "__main__":
    try:
        assert_collector_target()
        raise SystemExit(main(report_telemetry=True))
    except Exception as error:
        print(f"Hermes collector failed: {sanitize_error(error)}", file=sys.stderr)
        raise SystemExit(1)

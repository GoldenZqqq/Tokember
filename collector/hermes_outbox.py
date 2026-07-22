"""Bounded Hermes telemetry outbox persistence."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Callable


def empty_outbox() -> dict[str, Any]:
    return {"version": 1, "running": [], "reports": []}


def load_outbox(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if value.get("version") != 1 or not isinstance(value.get("running"), list):
            return empty_outbox()
        if not isinstance(value.get("reports"), list):
            return empty_outbox()
        return value
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return empty_outbox()


def save_outbox(state: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(state, separators=(",", ":")), encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def recover_and_begin_run(
    start: dict[str, Any], path: Path, max_reports: int,
    recover: Callable[[dict[str, Any]], dict[str, Any]],
) -> None:
    state = load_outbox(path)
    recovered = [recover(run) for run in state["running"]]
    state["running"] = [start]
    state["reports"] = (state["reports"] + recovered)[-max_reports:]
    save_outbox(state, path)


def finish_pending_run(report: dict[str, Any], path: Path, max_reports: int) -> None:
    state = load_outbox(path)
    state["running"] = [run for run in state["running"] if run["run_id"] != report["run_id"]]
    reports = [item for item in state["reports"] if item["run_id"] != report["run_id"]]
    state["reports"] = (reports + [report])[-max_reports:]
    save_outbox(state, path)


def flush_pending_runs(
    path: Path, send: Callable[[dict[str, Any]], None],
) -> int:
    state = load_outbox(path)
    failed = []
    sent = 0
    for report in state["reports"]:
        try:
            send(report)
            sent += 1
        except Exception:
            failed.append(report)
    state["reports"] = failed
    save_outbox(state, path)
    return sent

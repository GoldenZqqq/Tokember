"""Local-only Hermes attribution secret and HMAC helpers."""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import secrets
from pathlib import Path


SECRET_BYTES = 32


def attribution_context(path: Path) -> tuple[bool, str | None]:
    raw = (
        os.getenv("TOKEMBER_ATTRIBUTION_ENABLED")
        or os.getenv("AI_BURN_ATTRIBUTION_ENABLED")
        or "false"
    ).lower()
    if raw not in ("0", "1", "false", "true"):
        raise ValueError("TOKEMBER_ATTRIBUTION_ENABLED must be true or false")
    enabled = raw in ("1", "true")
    return enabled, load_or_create_secret(path) if enabled else None


def load_or_create_secret(path: Path) -> str:
    try:
        value = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        value = base64.urlsafe_b64encode(secrets.token_bytes(SECRET_BYTES)).decode().rstrip("=")
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            return load_or_create_secret(path)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(value + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    if len(value) != 43 or re.fullmatch(r"[A-Za-z0-9_-]+", value) is None:
        raise ValueError("Attribution secret file is invalid")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return value


def anonymous_id(domain: str, provider: str, seed: str, secret: str) -> str:
    payload = f"tokember-attribution-v1\0{domain}\0{provider}\0{seed}".encode()
    digest = hmac.new(secret.encode(), payload, hashlib.sha256).digest()
    encoded = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    prefix = "prj" if domain == "project" else "ses"
    return f"{prefix}_v1_{encoded}"

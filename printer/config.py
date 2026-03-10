"""
config.py — Loads environment variables and exposes a single CONFIG object.
All other modules import from here. Raises on missing required vars at startup.
"""

import os
import sys
from pathlib import Path
from dotenv import load_dotenv

# Load .env from the same directory as this file
_env_path = Path(__file__).parent / ".env"
load_dotenv(dotenv_path=_env_path)


def _require(key: str) -> str:
    """Get a required env var or exit with a clear error."""
    val = os.getenv(key)
    if not val:
        print(f"[CONFIG] FATAL: Required environment variable '{key}' is not set.", file=sys.stderr)
        print(f"[CONFIG] Copy .env.example to .env and fill in the values.", file=sys.stderr)
        sys.exit(1)
    return val


def _get(key: str, default: str) -> str:
    return os.getenv(key, default)


class Config:
    # ── Server ───────────────────────────────────────────────────────────
    server_ws_url: str  = _require("QOPY_SERVER_WS")
    server_http_url: str = _get("QOPY_SERVER_HTTP", "http://localhost:5000")

    # ── Device identity ───────────────────────────────────────────────────
    device_id: str      = _require("QOPY_DEVICE_ID")
    api_key: str        = _require("QOPY_API_KEY")

    # ── Heartbeat ─────────────────────────────────────────────────────────
    heartbeat_interval: int = int(_get("QOPY_HEARTBEAT_INTERVAL", "30"))

    # ── Reconnect ─────────────────────────────────────────────────────────
    reconnect_base_delay: float = float(_get("QOPY_RECONNECT_BASE", "3"))
    reconnect_max_delay: float  = float(_get("QOPY_RECONNECT_MAX", "30"))

    # ── File handling ─────────────────────────────────────────────────────
    max_file_size_mb: int = int(_get("QOPY_MAX_FILE_SIZE_MB", "20"))
    max_file_size_bytes: int = max_file_size_mb * 1024 * 1024
    download_dir: str     = _get("QOPY_DOWNLOAD_DIR", "/tmp/qopy_downloads")

    # ── Queue ─────────────────────────────────────────────────────────────
    max_queue_size: int = int(_get("QOPY_MAX_QUEUE_SIZE", "10"))

    # ── Persistence ───────────────────────────────────────────────────────
    db_path: str = _get("QOPY_DB_PATH", "/var/lib/qopy/jobs.db")

    # ── Logging ───────────────────────────────────────────────────────────
    log_file: str    = _get("QOPY_LOG_FILE", "/var/log/qopy-printer.log")
    log_level: str   = _get("QOPY_LOG_LEVEL", "INFO")

    # ── Simulate mode ─────────────────────────────────────────────────────
    simulate: bool = _get("QOPY_SIMULATE", "0") == "1"

    # ── Job details timeout ───────────────────────────────────────────────
    job_details_timeout: float = float(_get("QOPY_JOB_DETAILS_TIMEOUT", "10"))

    # ── Print timeout ─────────────────────────────────────────────────────
    print_timeout: int = int(_get("QOPY_PRINT_TIMEOUT", "300"))


CONFIG = Config()

# Ensure download dir exists
Path(CONFIG.download_dir).mkdir(parents=True, exist_ok=True)

# Ensure DB parent dir exists (may fail on non-Pi without sudo — warn only)
try:
    Path(CONFIG.db_path).parent.mkdir(parents=True, exist_ok=True)
except PermissionError:
    # Fallback to local path so dev environments still work
    CONFIG.db_path = str(Path(__file__).parent / "jobs.db")

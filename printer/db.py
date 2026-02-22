"""
db.py — SQLite persistence layer for the job queue.

Schema:
  jobs(job_id TEXT PK, status TEXT, payload TEXT, created_at TEXT, updated_at TEXT)

Statuses: QUEUED | PROCESSING | COMPLETED | FAILED
"""

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from logger import get_logger

log = get_logger(__name__)

# Thread lock — sqlite3 connections are not thread-safe across threads,
# and asyncio may call these from executor threads.
_lock = threading.Lock()
_conn: Optional[sqlite3.Connection] = None


# ─────────────────────────────────────────────────────────────────────────────
# Initialisation
# ─────────────────────────────────────────────────────────────────────────────

def init(db_path: str) -> None:
    """Open (or create) the SQLite database and create the schema."""
    global _conn
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)

    with _lock:
        _conn = sqlite3.connect(db_path, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL;")
        _conn.execute("""
            CREATE TABLE IF NOT EXISTS jobs (
                job_id     TEXT PRIMARY KEY,
                status     TEXT NOT NULL,
                payload    TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        _conn.commit()

    log.info("DB initialised at %s", db_path)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_conn() -> sqlite3.Connection:
    if _conn is None:
        raise RuntimeError("DB not initialised — call db.init() first.")
    return _conn


# ─────────────────────────────────────────────────────────────────────────────
# CRUD
# ─────────────────────────────────────────────────────────────────────────────

def insert_job(job_id: str, status: str, payload: dict) -> None:
    """Insert a new job. Silently ignores duplicates (QUEUED twice)."""
    now = _now()
    with _lock:
        try:
            _get_conn().execute(
                "INSERT OR IGNORE INTO jobs (job_id, status, payload, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (job_id, status, json.dumps(payload), now, now),
            )
            _get_conn().commit()
        except sqlite3.Error as e:
            log.error("DB insert_job error: %s", e)


def update_job_status(job_id: str, status: str) -> None:
    """Update the status of an existing job."""
    with _lock:
        try:
            _get_conn().execute(
                "UPDATE jobs SET status = ?, updated_at = ? WHERE job_id = ?",
                (status, _now(), job_id),
            )
            _get_conn().commit()
        except sqlite3.Error as e:
            log.error("DB update_job_status error: %s", e)


def get_jobs_by_status(status: str) -> list[dict]:
    """Return all jobs with the given status, ordered by created_at ASC."""
    with _lock:
        try:
            rows = _get_conn().execute(
                "SELECT * FROM jobs WHERE status = ? ORDER BY created_at ASC",
                (status,),
            ).fetchall()
            return [_row_to_dict(r) for r in rows]
        except sqlite3.Error as e:
            log.error("DB get_jobs_by_status error: %s", e)
            return []


def get_processing_job() -> Optional[dict]:
    """Return the job currently in PROCESSING state (if any)."""
    with _lock:
        try:
            row = _get_conn().execute(
                "SELECT * FROM jobs WHERE status = 'PROCESSING' LIMIT 1"
            ).fetchone()
            return _row_to_dict(row) if row else None
        except sqlite3.Error as e:
            log.error("DB get_processing_job error: %s", e)
            return None


def get_job(job_id: str) -> Optional[dict]:
    """Return a job by ID."""
    with _lock:
        try:
            row = _get_conn().execute(
                "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
            return _row_to_dict(row) if row else None
        except sqlite3.Error as e:
            log.error("DB get_job error: %s", e)
            return None


def delete_old_jobs(keep_n: int = 100) -> None:
    """Prune old COMPLETED/FAILED jobs, keeping the N most recent."""
    with _lock:
        try:
            _get_conn().execute(
                """DELETE FROM jobs WHERE status IN ('COMPLETED', 'FAILED')
                   AND job_id NOT IN (
                       SELECT job_id FROM jobs
                       WHERE status IN ('COMPLETED', 'FAILED')
                       ORDER BY updated_at DESC LIMIT ?
                   )""",
                (keep_n,),
            )
            _get_conn().commit()
        except sqlite3.Error as e:
            log.error("DB delete_old_jobs error: %s", e)


def job_count_by_status() -> dict[str, int]:
    """Return counts grouped by status."""
    with _lock:
        try:
            rows = _get_conn().execute(
                "SELECT status, COUNT(*) AS cnt FROM jobs GROUP BY status"
            ).fetchall()
            return {r["status"]: r["cnt"] for r in rows}
        except sqlite3.Error as e:
            log.error("DB job_count_by_status error: %s", e)
            return {}


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    try:
        d["payload"] = json.loads(d["payload"])
    except (json.JSONDecodeError, KeyError):
        pass
    return d

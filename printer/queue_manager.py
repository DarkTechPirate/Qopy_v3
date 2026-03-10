"""
queue_manager.py — Persistent, rate-limited async job queue.

Combines asyncio.Queue (in-memory) with SQLite (persistence across reboots).
One job is processed at a time. Rate limiting rejects NEW_JOB if queue is full.
"""

import asyncio
from typing import Optional

import db
from config import CONFIG
from logger import get_logger

log = get_logger(__name__)


class QueueManager:
    """
    Thread-safe async job queue backed by SQLite.

    Usage:
        qm = QueueManager()
        await qm.restore_from_db()   # on startup
        accepted = await qm.try_enqueue(job_dict)
        job = await qm.get()
        qm.task_done()
    """

    def __init__(self) -> None:
        self._queue: asyncio.Queue = asyncio.Queue()
        self._is_processing = False
        self._processor_callback: Optional[callable] = None

    # ─── Public API ───────────────────────────────────────────────────────

    def set_processor_callback(self, callback: callable) -> None:
        """
        Register the async function to call when a job is ready.
        Called automatically after enqueue and after each job finishes.
        """
        self._processor_callback = callback

    async def restore_from_db(self) -> None:
        """
        On startup, re-enqueue any QUEUED jobs from SQLite.
        Also reset any stuck PROCESSING jobs back to QUEUED.
        """
        # Reset stuck PROCESSING job (Pi crashed mid-job)
        processing = db.get_processing_job()
        if processing:
            job_id = processing["job_id"]
            log.warning(
                "Found stuck PROCESSING job %s — resetting to QUEUED for retry.",
                job_id,
            )
            db.update_job_status(job_id, "QUEUED")

        # Restore all QUEUED jobs in order
        queued_jobs = db.get_jobs_by_status("QUEUED")
        for record in queued_jobs:
            payload = record.get("payload", record)  # payload is already a dict
            if isinstance(payload, dict):
                job = payload
            else:
                job = record
            log.info("Restored queued job: %s", job.get("jobId", record["job_id"]))
            await self._queue.put(job)

        log.info(
            "Queue restored from DB: %d job(s) ready.", len(queued_jobs)
        )

    async def try_enqueue(self, job: dict) -> bool:
        """
        Attempt to add a job to the queue.

        Returns False (and does NOT enqueue) if queue size >= MAX_QUEUE_SIZE.
        Returns True on success.
        """
        if self._queue.qsize() >= CONFIG.max_queue_size:
            log.warning(
                "Queue full (%d/%d) — rejecting job %s",
                self._queue.qsize(), CONFIG.max_queue_size,
                job.get("jobId", "?"),
            )
            return False

        await self.enqueue(job, persist=True)
        return True

    async def enqueue(self, job: dict, persist: bool = True) -> None:
        """Add a job to the in-memory queue (and optionally persist to SQLite)."""
        job_id = job.get("jobId", "unknown")
        if persist:
            db.insert_job(job_id, "QUEUED", job)
        await self._queue.put(job)
        log.info("Job enqueued: %s (queue size: %d)", job_id, self._queue.qsize())

        # Trigger processor if not already running
        if not self._is_processing and self._processor_callback:
            asyncio.create_task(self._processor_callback())

    async def get(self) -> dict:
        """Blocking get — waits until a job is available."""
        return await self._queue.get()

    def task_done(self) -> None:
        """Mark the current task as done (required by asyncio.Queue)."""
        try:
            self._queue.task_done()
        except ValueError:
            pass  # task_done called more times than put — ignore

    def size(self) -> int:
        """Return the current number of jobs in the in-memory queue."""
        return self._queue.qsize()

    def is_processing(self) -> bool:
        return self._is_processing

    def set_processing(self, value: bool) -> None:
        self._is_processing = value

    async def trigger_next(self) -> None:
        """Trigger the processor callback if there are pending jobs."""
        if (
            not self._is_processing
            and self._queue.qsize() > 0
            and self._processor_callback
        ):
            asyncio.create_task(self._processor_callback())


# Global singleton
queue_manager = QueueManager()

"""
job_processor.py — Full print job pipeline orchestrator.

Pipeline:
  1. Dequeue job
  2. Send JOB_ACCEPTED
  3. Request + await JOB_DETAILS (sha256, fileSize, downloadUrl, mimeType)
  4. File size check
  5. Download via aiohttp
  6. File type validation (extension + MIME)
  7. SHA-256 integrity check
  8. Send JOB_PRINTING
  9. Print (real lp or simulate)
  10. Monitor CUPS until confirmed
  11. Send JOB_COMPLETED / JOB_FAILED
  12. Cleanup temp file + update DB
  13. Trigger next job
"""

import asyncio
import os
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Optional

import aiohttp
import aiofiles

import db
import integrity
import printer as cups
from config import CONFIG
from logger import get_logger
from queue_manager import queue_manager

if TYPE_CHECKING:
    pass

log = get_logger(__name__)


class JobProcessor:
    """
    Manages the sequential processing of print jobs.

    The client.py instantiates one JobProcessor and calls process_next()
    when a new job arrives or after a job finishes.
    """

    def __init__(self, send_fn: Callable) -> None:
        """
        Args:
            send_fn: async callable that sends a JSON message over WebSocket.
                     Signature: async def send(msg: dict) -> None
        """
        self._send = send_fn
        self._details_future: Optional[asyncio.Future] = None
        queue_manager.set_processor_callback(self.process_next)

    # ─────────────────────────────────────────────────────────────────────
    # Entry Point
    # ─────────────────────────────────────────────────────────────────────

    async def process_next(self) -> None:
        """
        Dequeue and process the next job. No-op if already processing.
        Called automatically by queue_manager on enqueue.
        """
        if queue_manager.is_processing():
            return
        if queue_manager.size() == 0:
            return

        queue_manager.set_processing(True)
        job = await queue_manager.get()
        job_id = job.get("jobId", "unknown")

        log.info("━" * 50)
        log.info("Processing job: %s | file: %s", job_id, job.get("fileName", "?"))

        file_path: Optional[str] = None

        try:
            # ── Step 1: Accept ────────────────────────────────────────────
            db.update_job_status(job_id, "PROCESSING")
            await self._send({"type": "JOB_ACCEPTED", "jobId": job_id})
            log.info("[%s] Accepted", job_id[:8])

            # ── Step 2: Request details ───────────────────────────────────
            details = await self._request_job_details(job_id)
            download_url = details.get("downloadUrl") or details.get("fileUrl")
            expected_sha  = details.get("sha256", "")
            file_size     = details.get("fileSize", 0)
            mime_type     = details.get("mimeType", "application/pdf")

            if not download_url:
                raise ValueError("JOB_DETAILS is missing downloadUrl/fileUrl")

            # ── Step 3: File size check ───────────────────────────────────
            if file_size > CONFIG.max_file_size_bytes:
                mb = file_size / 1024 / 1024
                limit = CONFIG.max_file_size_mb
                raise ValueError(
                    f"File too large: {mb:.1f} MB (limit: {limit} MB)"
                )
            log.info("[%s] File size OK: %.1f MB", job_id[:8], file_size / 1024 / 1024)

            # ── Step 4: Download ──────────────────────────────────────────
            file_path = os.path.join(CONFIG.download_dir, f"{job_id}.pdf")
            await self._download_file(download_url, file_path, job_id)

            # ── Step 5: File type validation ──────────────────────────────
            integrity.validate_file_type(file_path)

            # ── Step 6: SHA-256 integrity check ───────────────────────────
            if expected_sha:
                integrity.verify_sha256(file_path, expected_sha)
            else:
                log.warning(
                    "[%s] No sha256 provided by server — skipping integrity check!", job_id[:8]
                )

            # ── Step 7: Start printing ────────────────────────────────────
            await self._send({"type": "JOB_PRINTING", "jobId": job_id})
            log.info("[%s] Sending to printer...", job_id[:8])

            if CONFIG.simulate:
                await self._simulate(job, job_id)
            else:
                await self._print_real(job, job_id, file_path)

            # ── Step 8: Completed ─────────────────────────────────────────
            await self._send({"type": "JOB_COMPLETED", "jobId": job_id, "message": "Printed successfully"})
            db.update_job_status(job_id, "COMPLETED")
            log.info("[%s] ✓ JOB COMPLETED", job_id[:8])

        except asyncio.TimeoutError as exc:
            await self._fail(job_id, f"Timeout: {exc}")
        except (ValueError, FileNotFoundError, RuntimeError) as exc:
            await self._fail(job_id, str(exc))
        except Exception as exc:
            log.exception("[%s] Unexpected error", job_id[:8])
            await self._fail(job_id, f"Unexpected error: {exc}")
        finally:
            # ── Cleanup ───────────────────────────────────────────────────
            if file_path and os.path.exists(file_path):
                try:
                    os.unlink(file_path)
                    log.debug("Deleted temp file: %s", file_path)
                except OSError:
                    pass

            queue_manager.task_done()
            queue_manager.set_processing(False)
            db.delete_old_jobs(keep_n=100)

            log.info("━" * 50)
            # Process next job in queue
            await queue_manager.trigger_next()

    # ─────────────────────────────────────────────────────────────────────
    # Job Details (async Future)
    # ─────────────────────────────────────────────────────────────────────

    async def _request_job_details(self, job_id: str) -> dict:
        """
        Send REQUEST_JOB_DETAILS and wait for the server's JOB_DETAILS response.
        The future is resolved by on_job_details() called from client.py.
        """
        loop = asyncio.get_event_loop()
        self._details_future = loop.create_future()

        await self._send({"type": "REQUEST_JOB_DETAILS", "jobId": job_id})
        log.info("[%s] Waiting for job details...", job_id[:8])

        try:
            details = await asyncio.wait_for(
                self._details_future, timeout=CONFIG.job_details_timeout
            )
        except asyncio.TimeoutError:
            self._details_future = None
            raise asyncio.TimeoutError(
                f"Server did not respond to REQUEST_JOB_DETAILS within "
                f"{CONFIG.job_details_timeout}s"
            )

        log.info("[%s] Received job details", job_id[:8])
        return details

    def on_job_details(self, msg: dict) -> None:
        """Called by client.py when JOB_DETAILS message arrives."""
        if self._details_future and not self._details_future.done():
            self._details_future.set_result(msg)
        else:
            log.warning("Received JOB_DETAILS but no future is pending — ignoring.")

    # ─────────────────────────────────────────────────────────────────────
    # Download
    # ─────────────────────────────────────────────────────────────────────

    async def _download_file(self, url: str, dest_path: str, job_id: str) -> None:
        """Download the print file using aiohttp."""
        # Build full URL if relative path
        if url.startswith("/"):
            url = CONFIG.server_http_url.rstrip("/") + url

        log.info("[%s] Downloading: %s → %s", job_id[:8], url, dest_path)

        headers = {
            "device-id": CONFIG.device_id,
            "authorization": CONFIG.api_key,
        }

        timeout = aiohttp.ClientTimeout(total=120)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers=headers) as resp:
                if resp.status != 200:
                    body = await resp.text()
                    raise RuntimeError(
                        f"Download failed: HTTP {resp.status} — {body[:200]}"
                    )

                # Stream to disk
                async with aiofiles.open(dest_path, "wb") as f:
                    async for chunk in resp.content.iter_chunked(65536):
                        await f.write(chunk)

        size_kb = os.path.getsize(dest_path) / 1024
        log.info("[%s] Downloaded %.1f KB → %s", job_id[:8], size_kb, dest_path)

    # ─────────────────────────────────────────────────────────────────────
    # Printing
    # ─────────────────────────────────────────────────────────────────────

    async def _print_real(self, job: dict, job_id: str, file_path: str) -> None:
        """Submit to CUPS and monitor until complete."""
        cups_job_id = await cups.print_file(file_path, job)
        log.info("[%s] CUPS job ID: %s", job_id[:8], cups_job_id)

        # Send progress updates while monitoring
        pages = job.get("pages", 1) * job.get("copies", 1)
        await self._send({
            "type": "JOB_PROGRESS",
            "jobId": job_id,
            "printedPages": 0,
            "totalPages": pages,
            "message": "Print job submitted to CUPS",
        })

        await cups.monitor_print_job(cups_job_id, timeout=CONFIG.print_timeout)

        await self._send({
            "type": "JOB_PROGRESS",
            "jobId": job_id,
            "printedPages": pages,
            "totalPages": pages,
            "message": "Print confirmed by CUPS",
        })

    async def _simulate(self, job: dict, job_id: str) -> None:
        """Simulate printing without sending to a real printer."""
        pages = job.get("pages", 1)
        copies = job.get("copies", 1)
        total = pages * copies

        async def on_page(page_num: int, total_pages: int) -> None:
            await self._send({
                "type": "JOB_PROGRESS",
                "jobId": job_id,
                "printedPages": page_num,
                "totalPages": total_pages,
                "message": f"[SIMULATE] Printing page {page_num} of {total_pages}",
            })

        await cups.simulate_print(job, on_page=on_page)

    # ─────────────────────────────────────────────────────────────────────
    # Error helper
    # ─────────────────────────────────────────────────────────────────────

    async def _fail(self, job_id: str, reason: str) -> None:
        log.error("[%s] JOB FAILED: %s", job_id[:8], reason)
        db.update_job_status(job_id, "FAILED")
        try:
            await self._send({"type": "JOB_FAILED", "jobId": job_id, "message": reason})
        except Exception:
            pass  # WebSocket may be disconnected

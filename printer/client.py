"""
client.py — WebSocket client with full message handler and reconnect logic.

Responsibilities:
  - Connect to the server WebSocket with exponential backoff
  - Send REGISTER + DEVICE_STATUS on connect
  - Route all incoming messages to the correct handler
  - Send HEARTBEAT every 30s with live CUPS status
  - Forward JOB_DETAILS to job_processor to unblock its Future
  - Provide send() for all other modules to use
"""

import asyncio
import json
from typing import Optional

import websockets
import websockets.exceptions

import db
import printer as cups
from config import CONFIG
from fingerprint import get_fingerprint
from job_processor import JobProcessor
from logger import get_logger
from queue_manager import queue_manager

log = get_logger(__name__)


class QopyClient:
    """
    WebSocket client for the Qopy printer service.

    Call `await client.start()` from main.py to begin the connection loop.
    """

    def __init__(self) -> None:
        self._ws: Optional[websockets.WebSocketClientProtocol] = None
        self._connected = False
        self._registered = False
        self._reconnect_attempts = 0
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._job_processor = JobProcessor(send_fn=self.send)

    # ─────────────────────────────────────────────────────────────────────
    # Outer reconnect loop
    # ─────────────────────────────────────────────────────────────────────

    async def start(self) -> None:
        """
        Outer loop: connect, run, reconnect on any disconnect.
        Runs forever until the process is killed.
        """
        log.info("Qopy Printer Agent starting (device: %s)", CONFIG.device_id)
        log.info("Server: %s", CONFIG.server_ws_url)
        if CONFIG.simulate:
            log.warning("SIMULATION MODE — no real printer will be used.")

        while True:
            try:
                await self._connect()
            except (
                OSError,
                websockets.exceptions.WebSocketException,
                ConnectionRefusedError,
            ) as exc:
                log.warning("Connection lost: %s", exc)
            except asyncio.CancelledError:
                log.info("Client cancelled — shutting down.")
                break
            except Exception as exc:
                log.exception("Unexpected error in connection loop: %s", exc)

            self._connected = False
            self._registered = False
            self._cancel_heartbeat()

            if self._reconnect_attempts == 0:
                log.info("Disconnected from server.")

            delay = min(
                CONFIG.reconnect_base_delay * (2 ** self._reconnect_attempts),
                CONFIG.reconnect_max_delay,
            )
            self._reconnect_attempts += 1
            log.info(
                "Reconnecting in %.0fs (attempt #%d)...",
                delay, self._reconnect_attempts,
            )
            await asyncio.sleep(delay)

    async def close(self) -> None:
        """Gracefully close the WebSocket connection."""
        self._cancel_heartbeat()
        if self._ws:
            await self._ws.close()

    # ─────────────────────────────────────────────────────────────────────
    # Connect + message loop
    # ─────────────────────────────────────────────────────────────────────

    async def _connect(self) -> None:
        """Connect and run the receive loop until disconnected."""
        log.info("Connecting to %s ...", CONFIG.server_ws_url)

        async with websockets.connect(
            CONFIG.server_ws_url,
            ping_interval=20,
            ping_timeout=10,
            close_timeout=5,
        ) as ws:
            self._ws = ws
            self._connected = True
            self._reconnect_attempts = 0
            log.info("Connected ✓")

            # Always register on connect
            await self._register()

            # Receive loop
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    log.warning("Received non-JSON message — ignoring.")
                    continue
                await self._handle_message(msg)

    # ─────────────────────────────────────────────────────────────────────
    # Send
    # ─────────────────────────────────────────────────────────────────────

    async def send(self, msg: dict) -> None:
        """Serialize and send a JSON message over WebSocket."""
        if self._ws is None:
            log.warning("Cannot send — WebSocket not open. msg: %s", msg.get("type"))
            return
        # websockets < v14 had .open; v14+ uses .state
        try:
            from websockets.connection import State
            is_open = self._ws.state is State.OPEN
        except ImportError:
            is_open = getattr(self._ws, "open", False)

        if is_open:
            try:
                await self._ws.send(json.dumps(msg))
                log.debug("→ %s", msg.get("type", "?"))
            except websockets.exceptions.WebSocketException as exc:
                log.error("Send failed: %s", exc)
        else:
            log.warning("Cannot send — WebSocket not open. msg: %s", msg.get("type"))


    # ─────────────────────────────────────────────────────────────────────
    # Registration
    # ─────────────────────────────────────────────────────────────────────

    async def _register(self) -> None:
        """Send REGISTER with device credentials and hardware fingerprint."""
        await self.send({
            "type":        "REGISTER",
            "deviceId":    CONFIG.device_id,
            "apiKey":      CONFIG.api_key,
            "fingerprint": get_fingerprint(),
        })
        log.info("REGISTER sent (deviceId: %s)", CONFIG.device_id)

    async def _send_device_status(self) -> None:
        """
        Send DEVICE_STATUS for crash recovery.
        Tells the server if there was an interrupted job on restart.
        """
        processing_job = db.get_processing_job()
        pending_job_id = processing_job["job_id"] if processing_job else None

        if pending_job_id:
            log.info("Crash recovery: reporting pending job %s to server.", pending_job_id)

        await self.send({
            "type":           "DEVICE_STATUS",
            "deviceId":       CONFIG.device_id,
            "pendingJobId":   pending_job_id,
            "queueLength":    queue_manager.size(),
            "printerStatus":  cups.get_printer_status(),
        })

    # ─────────────────────────────────────────────────────────────────────
    # Message Handler
    # ─────────────────────────────────────────────────────────────────────

    async def _handle_message(self, msg: dict) -> None:
        """Dispatch incoming server messages to the correct handler."""
        msg_type = msg.get("type", "UNKNOWN")
        log.debug("← %s", msg_type)

        match msg_type:
            case "REGISTERED":
                await self._on_registered(msg)

            case "AUTH_FAILED":
                log.error(
                    "Authentication failed: %s — check QOPY_DEVICE_ID and QOPY_API_KEY.",
                    msg.get("reason", "unknown"),
                )
                self._registered = False

            case "NEW_JOB":
                await self._on_new_job(msg)

            case "JOB_DETAILS":
                self._on_job_details(msg)

            case "PENDING_JOB":
                # Server confirmed a pending job — re-enqueue it
                await self._on_pending_job(msg)

            case "JOB_ACK":
                log.debug("Server acknowledged JOB_ACCEPTED for job %s", msg.get("jobId"))

            case "HEARTBEAT_ACK":
                log.debug("Heartbeat acknowledged by server.")

            case "ERROR":
                log.error("Server error: %s", msg.get("message", "unknown"))

            case _:
                log.debug("Unhandled message type: %s", msg_type)

    async def _on_registered(self, msg: dict) -> None:
        self._registered = True
        log.info("Registered ✓ (server: %s)", msg.get("serverVersion", "?"))

        # Start heartbeat
        self._cancel_heartbeat()
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

        # Crash recovery
        await self._send_device_status()

        # Resume any jobs that were queued from DB restore
        await queue_manager.trigger_next()

    async def _on_new_job(self, msg: dict) -> None:
        job = msg.get("job") or msg  # server may wrap in "job" key or not
        job_id = job.get("jobId", "?")
        log.info("NEW_JOB received: %s (file: %s)", job_id, job.get("fileName", "?"))

        accepted = await queue_manager.try_enqueue(job)
        if not accepted:
            await self.send({
                "type":   "JOB_REJECTED",
                "jobId":  job_id,
                "reason": "queue_full",
            })
            log.warning("Job %s rejected — queue is full (%d max).", job_id, CONFIG.max_queue_size)

    def _on_job_details(self, msg: dict) -> None:
        """Forward JOB_DETAILS to the job processor to unblock its Future."""
        self._job_processor.on_job_details(msg)

    async def _on_pending_job(self, msg: dict) -> None:
        """Handle PENDING_JOB from server (crash recovery response)."""
        job = msg.get("job")
        if job:
            job_id = job.get("jobId", "?")
            log.info("Server sent PENDING_JOB %s — re-enqueueing.", job_id)
            # Put at head of queue by inserting before restoring others
            await queue_manager.enqueue(job, persist=True)

    # ─────────────────────────────────────────────────────────────────────
    # Heartbeat Loop
    # ─────────────────────────────────────────────────────────────────────

    async def _heartbeat_loop(self) -> None:
        """Send a HEARTBEAT every CONFIG.heartbeat_interval seconds."""
        log.debug("Heartbeat loop started (interval: %ds).", CONFIG.heartbeat_interval)
        while self._registered and self._connected:
            await asyncio.sleep(CONFIG.heartbeat_interval)
            if not self._registered:
                break

            printer_status  = cups.get_printer_status()
            cups_job_count  = cups.get_active_job_count()

            await self.send({
                "type":          "HEARTBEAT",
                "deviceId":      CONFIG.device_id,
                "printerStatus": printer_status,
                "cupsJobCount":  cups_job_count,
                "queueLength":   queue_manager.size(),
                "isProcessing":  queue_manager.is_processing(),
            })
            log.debug(
                "Heartbeat sent (printer=%s, cupsJobs=%s, queue=%d)",
                printer_status, cups_job_count, queue_manager.size(),
            )

    def _cancel_heartbeat(self) -> None:
        if self._heartbeat_task and not self._heartbeat_task.done():
            self._heartbeat_task.cancel()
        self._heartbeat_task = None

"""
main.py — Entry point for the Qopy Printer Agent.

Startup sequence:
  1. Init logging
  2. Init SQLite database
  3. Restore persisted queue from DB
  4. Connect to server via WebSocket (reconnects automatically)

Handles SIGINT / SIGTERM for graceful shutdown.
"""

import asyncio
import signal
import sys

# Bootstrap logging first (before other local imports)
import logger  # noqa: F401 — side-effect import to configure root logger

import db
from client import QopyClient
from config import CONFIG
from logger import get_logger
from queue_manager import queue_manager

log = get_logger(__name__)


async def _async_main() -> None:
    """Full async startup sequence."""
    # ── 1. Init database ──────────────────────────────────────────────────
    log.info("Initialising database at: %s", CONFIG.db_path)
    db.init(CONFIG.db_path)

    # ── 2. Restore queue ──────────────────────────────────────────────────
    log.info("Restoring job queue from database...")
    await queue_manager.restore_from_db()

    # ── 3. Start WebSocket client ─────────────────────────────────────────
    client = QopyClient()

    # ── 4. Register graceful shutdown ─────────────────────────────────────
    loop = asyncio.get_event_loop()

    def _shutdown(sig_name: str) -> None:
        log.info("Signal %s received — shutting down gracefully...", sig_name)
        # Schedule client close then stop the loop
        loop.create_task(_do_shutdown(client))

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, lambda s=sig.name: _shutdown(s))
        except (NotImplementedError, ValueError):
            # Signal handling may not be available on all platforms (e.g., Windows)
            pass

    # ── 5. Run ────────────────────────────────────────────────────────────
    try:
        await client.start()
    except asyncio.CancelledError:
        pass


async def _do_shutdown(client: QopyClient) -> None:
    """Close WebSocket and cancel all tasks."""
    await client.close()
    tasks = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    asyncio.get_event_loop().stop()


def main() -> None:
    """Synchronous entry point."""
    log.info("=" * 60)
    log.info("  QOPY PRINTER AGENT")
    log.info("  Device : %s", CONFIG.device_id)
    log.info("  Server : %s", CONFIG.server_ws_url)
    log.info("  Simulate: %s", "YES" if CONFIG.simulate else "NO")
    log.info("  DB     : %s", CONFIG.db_path)
    log.info("=" * 60)

    try:
        asyncio.run(_async_main())
    except KeyboardInterrupt:
        log.info("Interrupted by user.")
    finally:
        log.info("Qopy Printer Agent stopped.")
        sys.exit(0)


if __name__ == "__main__":
    main()

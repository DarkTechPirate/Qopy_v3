"""
printer.py — CUPS abstraction layer.

Provides:
  print_file()           — submit job to CUPS via `lp`, returns CUPS job ID
  monitor_print_job()    — poll `lpstat` until done or error
  get_printer_status()   — query live CUPS printer state via pycups
  get_active_job_count() — return number of active CUPS jobs
  simulate_print()       — fake print for testing (QOPY_SIMULATE=1)
"""

import asyncio
import re
import subprocess
from typing import Optional

from logger import get_logger

log = get_logger(__name__)

# CUPS state codes
_CUPS_STATES = {3: "idle", 4: "printing", 5: "stopped"}


# ─────────────────────────────────────────────────────────────────────────────
# Submit print job
# ─────────────────────────────────────────────────────────────────────────────

async def print_file(file_path: str, job: dict) -> str:
    """
    Submit a file to CUPS via `lp`. Returns the CUPS job ID string.

    Args:
        file_path: absolute path to the downloaded PDF
        job:       job dict from the server (sided, copies, printType, etc.)

    Raises:
        RuntimeError: if lp returns non-zero or job ID cannot be parsed.
    """
    sided   = job.get("sided", "single")
    copies  = str(job.get("copies", 1))
    color   = job.get("printType", "bw")  # "bw" | "color"

    sides_opt = "two-sided-long-edge" if sided == "double" else "one-sided"

    cmd = ["lp", "-n", copies, "-o", f"sides={sides_opt}"]
    if color == "bw":
        cmd += ["-o", "ColorModel=Gray"]
    cmd.append(file_path)

    log.info("Submitting print: %s", " ".join(cmd))

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError("lp submission timed out after 30s")

    if proc.returncode != 0:
        raise RuntimeError(f"lp failed (exit {proc.returncode}): {stderr.decode().strip()}")

    # Parse CUPS job ID from: "request id is PrinterName-42 (1 file(s))"
    stdout_str = stdout.decode().strip()
    match = re.search(r"request id is (\S+)", stdout_str)
    if not match:
        raise RuntimeError(f"Cannot parse CUPS job ID from lp output: {stdout_str!r}")

    cups_job_id = match.group(1)
    log.info("CUPS job accepted: %s", cups_job_id)
    return cups_job_id


# ─────────────────────────────────────────────────────────────────────────────
# Monitor CUPS job until complete
# ─────────────────────────────────────────────────────────────────────────────

async def monitor_print_job(
    cups_job_id: str,
    timeout: int = 300,
    poll_interval: float = 3.0,
) -> None:
    """
    Poll `lpstat -o <cups_job_id>` until the job leaves the queue.

    An empty lpstat output means the job completed successfully.
    If the output contains 'error' or 'stopped', raise RuntimeError.

    Args:
        cups_job_id:   CUPS job ID returned by print_file()
        timeout:       max seconds to wait (default 300)
        poll_interval: seconds between polls (default 3)

    Raises:
        RuntimeError:  if CUPS reports an error or job is stopped.
        TimeoutError:  if the job doesn't finish within `timeout` seconds.
    """
    deadline = asyncio.get_event_loop().time() + timeout
    log.info("Monitoring CUPS job: %s (timeout=%ds)", cups_job_id, timeout)

    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            raise TimeoutError(
                f"CUPS job {cups_job_id} did not complete within {timeout}s"
            )

        result = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: subprocess.run(
                ["lpstat", "-o", cups_job_id],
                capture_output=True, text=True
            )
        )

        output = result.stdout.strip()

        if not output:
            # Job is no longer in the active queue = completed
            log.info("CUPS job %s completed (no longer in queue)", cups_job_id)
            return

        lower = output.lower()
        if "error" in lower or "stopped" in lower or "aborted" in lower:
            raise RuntimeError(f"CUPS job error: {output}")

        log.debug("CUPS job %s still active: %s", cups_job_id, output[:80])
        await asyncio.sleep(poll_interval)


# ─────────────────────────────────────────────────────────────────────────────
# CUPS status queries
# ─────────────────────────────────────────────────────────────────────────────

def get_printer_status() -> str:
    """
    Return the live CUPS printer state as a string.

    Returns: "idle" | "printing" | "stopped" | "no_printer" | "error"
    Requires: pip install pycups
    """
    try:
        import cups  # pycups
        conn = cups.Connection()
        printers = conn.getPrinters()
        if not printers:
            return "no_printer"
        # Use the first configured printer
        name = next(iter(printers))
        state = printers[name].get("printer-state", 0)
        return _CUPS_STATES.get(state, "error")
    except ImportError:
        # pycups not installed — fall back to lpstat
        return _lpstat_status()
    except Exception as exc:
        log.warning("CUPS status query failed: %s", exc)
        return "error"


def get_active_job_count() -> int:
    """Return the number of jobs currently in the CUPS queue (-1 on error)."""
    try:
        import cups
        conn = cups.Connection()
        return len(conn.getJobs())
    except ImportError:
        return _lpstat_job_count()
    except Exception as exc:
        log.warning("CUPS job count query failed: %s", exc)
        return -1


# ─────────────────────────────────────────────────────────────────────────────
# lpstat fallbacks (when pycups is not available)
# ─────────────────────────────────────────────────────────────────────────────

def _lpstat_status() -> str:
    """Fallback: parse `lpstat -p` for printer state."""
    try:
        result = subprocess.run(
            ["lpstat", "-p"], capture_output=True, text=True, timeout=5
        )
        out = result.stdout.lower()
        if not out.strip():
            return "no_printer"
        if "printing" in out:
            return "printing"
        if "idle" in out or "enabled" in out:
            return "idle"
        if "stopped" in out or "disabled" in out:
            return "stopped"
        return "error"
    except Exception:
        return "error"


def _lpstat_job_count() -> int:
    """Fallback: count lines from `lpstat -o`."""
    try:
        result = subprocess.run(
            ["lpstat", "-o"], capture_output=True, text=True, timeout=5
        )
        lines = [l for l in result.stdout.strip().splitlines() if l.strip()]
        return len(lines)
    except Exception:
        return -1


# ─────────────────────────────────────────────────────────────────────────────
# Simulation mode
# ─────────────────────────────────────────────────────────────────────────────

async def simulate_print(job: dict, on_page: Optional[callable] = None) -> None:
    """
    Simulate printing for testing without a real printer.

    Waits 1.5s per page and calls on_page(page_num, total) for each page.
    """
    pages  = job.get("pages", 1)
    copies = job.get("copies", 1)
    total  = pages * copies
    log.info("[SIMULATE] Printing %d pages × %d copies = %d total", pages, copies, total)

    for i in range(1, total + 1):
        await asyncio.sleep(1.5)
        log.info("[SIMULATE] Page %d / %d", i, total)
        if on_page:
            await on_page(i, total)

    log.info("[SIMULATE] Print complete.")

"""
logger.py — Sets up application-wide logging.

Two handlers:
  1. RotatingFileHandler → writes to QOPY_LOG_FILE (5 MB × 3 backups)
  2. StreamHandler       → colored terminal output

Usage:
  from logger import get_logger
  log = get_logger(__name__)
  log.info("Hello")
"""

import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

# ANSI colour codes for terminal
_COLOURS = {
    "DEBUG":    "\x1b[36m",    # cyan
    "INFO":     "\x1b[32m",    # green
    "WARNING":  "\x1b[33m",    # yellow
    "ERROR":    "\x1b[31m",    # red
    "CRITICAL": "\x1b[1;31m",  # bold red
}
_RESET = "\x1b[0m"


class _ColourFormatter(logging.Formatter):
    """Terminal formatter that adds ANSI colour to the level name."""

    FMT = "%(asctime)s  %(levelname)-8s  %(name)s — %(message)s"
    DATEFMT = "%H:%M:%S"

    def format(self, record: logging.LogRecord) -> str:
        colour = _COLOURS.get(record.levelname, "")
        record.levelname = f"{colour}{record.levelname}{_RESET}"
        formatter = logging.Formatter(self.FMT, datefmt=self.DATEFMT)
        return formatter.format(record)


class _PlainFormatter(logging.Formatter):
    """Plain formatter for file output (no ANSI codes)."""

    FMT = "%(asctime)s  %(levelname)-8s  %(name)s — %(message)s"
    DATEFMT = "%Y-%m-%d %H:%M:%S"

    def format(self, record: logging.LogRecord) -> str:
        formatter = logging.Formatter(self.FMT, datefmt=self.DATEFMT)
        return formatter.format(record)


def _setup() -> None:
    """Bootstrap root logger — called once at import time."""
    # Avoid importing CONFIG here to keep logger self-contained
    import os
    log_file  = os.getenv("QOPY_LOG_FILE", "/var/log/qopy-printer.log")
    log_level = os.getenv("QOPY_LOG_LEVEL", "INFO").upper()

    root = logging.getLogger()
    root.setLevel(log_level)

    if root.handlers:
        return  # already configured

    # ── File handler ──────────────────────────────────────────────────────
    try:
        Path(log_file).parent.mkdir(parents=True, exist_ok=True)
        fh = RotatingFileHandler(
            log_file, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
        )
        fh.setFormatter(_PlainFormatter())
        root.addHandler(fh)
    except PermissionError:
        # On dev machines /var/log may be root-only — fall back to local file
        local_log = str(Path(__file__).parent / "qopy-printer.log")
        fh = RotatingFileHandler(
            local_log, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
        )
        fh.setFormatter(_PlainFormatter())
        root.addHandler(fh)

    # ── Console handler ───────────────────────────────────────────────────
    ch = logging.StreamHandler(sys.stdout)
    ch.setFormatter(_ColourFormatter())
    root.addHandler(ch)

    # Silence noisy third-party loggers
    logging.getLogger("websockets").setLevel(logging.WARNING)
    logging.getLogger("aiohttp").setLevel(logging.WARNING)


_setup()


def get_logger(name: str) -> logging.Logger:
    """Return a named logger. Call this at the top of every module."""
    return logging.getLogger(name)

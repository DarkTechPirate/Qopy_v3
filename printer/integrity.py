"""
integrity.py — File security gates before printing.

Two checks:
  1. SHA-256 hash verification  — protects against MITM / corrupted downloads
  2. MIME type validation       — only PDF files are allowed to print

Both raise ValueError on failure so job_processor can catch and send JOB_FAILED.
"""

import hashlib
import os
from logger import get_logger

log = get_logger(__name__)

# ── Allowed file types ────────────────────────────────────────────────────────
ALLOWED_EXTENSIONS = {".pdf"}
ALLOWED_MIMES = {"application/pdf"}


# ─────────────────────────────────────────────────────────────────────────────
# SHA-256 Integrity Check
# ─────────────────────────────────────────────────────────────────────────────

def verify_sha256(file_path: str, expected_hash: str) -> None:
    """
    Compute the SHA-256 of file_path and compare against expected_hash.

    Raises:
        ValueError: if the hashes do not match.
        FileNotFoundError: if the file does not exist.
    """
    sha = hashlib.sha256()
    try:
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                sha.update(chunk)
    except FileNotFoundError:
        raise FileNotFoundError(f"Downloaded file not found: {file_path}")

    actual = sha.hexdigest()
    if actual.lower() != expected_hash.lower():
        log.error(
            "Hash mismatch for %s — expected %s, got %s",
            os.path.basename(file_path), expected_hash, actual,
        )
        raise ValueError(
            f"Integrity check failed: hash mismatch "
            f"(expected {expected_hash[:12]}…, got {actual[:12]}…)"
        )

    log.info("SHA-256 OK: %s", os.path.basename(file_path))


# ─────────────────────────────────────────────────────────────────────────────
# File Type Validation
# ─────────────────────────────────────────────────────────────────────────────

def validate_file_type(file_path: str) -> None:
    """
    Validate both the file extension and the actual MIME type.

    Uses python-magic (libmagic) to read file magic bytes — extension alone
    is not sufficient because an attacker could rename a shell script to .pdf.

    Raises:
        ValueError: if extension or MIME type is not in the allowed sets.
    """
    # 1. Extension check
    _, ext = os.path.splitext(file_path)
    if ext.lower() not in ALLOWED_EXTENSIONS:
        raise ValueError(f"Rejected file type: extension '{ext}' not allowed")

    # 2. MIME check via libmagic
    try:
        import magic  # python-magic
        detected_mime = magic.from_file(file_path, mime=True)
    except ImportError:
        log.warning(
            "python-magic not installed — skipping MIME check. "
            "Install with: pip3 install python-magic"
        )
        return
    except Exception as exc:
        log.warning("MIME detection failed (%s) — skipping check.", exc)
        return

    if detected_mime not in ALLOWED_MIMES:
        log.error(
            "Rejected file %s — MIME type '%s' is not in whitelist %s",
            os.path.basename(file_path), detected_mime, ALLOWED_MIMES,
        )
        raise ValueError(
            f"Rejected file type: MIME '{detected_mime}' not allowed. "
            f"Only {ALLOWED_MIMES} are accepted."
        )

    log.info("File type OK: %s (%s)", os.path.basename(file_path), detected_mime)

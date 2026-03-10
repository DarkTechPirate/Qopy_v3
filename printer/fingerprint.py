"""
fingerprint.py — Collect hardware identifiers unique to this device.

Sent with every REGISTER message to prevent device-ID spoofing.
The server should store the fingerprint on first registration and
reject future connections where deviceId matches but fingerprint differs.
"""

import platform
import uuid
from logger import get_logger

log = get_logger(__name__)


def _get_mac_address() -> str:
    """Return the primary MAC address as a colon-separated string."""
    try:
        node = uuid.getnode()
        # uuid.getnode() may return a random value if MAC cannot be determined
        # (the multicast bit — bit 40 — is set in that case).
        if (node >> 40) & 1:
            log.warning("Could not determine real MAC address; using generated value.")
        mac = ":".join(
            f"{(node >> i) & 0xFF:02x}" for i in range(40, -1, -8)
        )
        return mac
    except Exception as exc:
        log.warning("MAC address lookup failed: %s", exc)
        return "unknown"


def _get_pi_serial() -> str:
    """Read the Raspberry Pi CPU serial number from /proc/cpuinfo."""
    try:
        with open("/proc/cpuinfo", "r") as f:
            for line in f:
                if line.startswith("Serial"):
                    return line.strip().split(":")[-1].strip()
    except FileNotFoundError:
        pass  # Not running on a Pi
    except Exception as exc:
        log.warning("Pi serial lookup failed: %s", exc)
    return "unknown"


def _get_pi_model() -> str:
    """Read the Raspberry Pi model string from /proc/cpuinfo."""
    try:
        with open("/proc/cpuinfo", "r") as f:
            for line in f:
                if line.startswith("Model"):
                    return line.strip().split(":", 1)[-1].strip()
    except Exception:
        pass
    return "unknown"


def get_fingerprint() -> dict:
    """
    Return a dictionary of hardware and OS identifiers.

    This is included in the REGISTER WebSocket message so the server
    can bind a deviceId to a specific physical device.
    """
    fp = {
        "macAddress": _get_mac_address(),
        "piSerial":   _get_pi_serial(),
        "piModel":    _get_pi_model(),
        "osVersion":  platform.version(),
        "osPlatform": platform.platform(),
        "hostname":   platform.node(),
        "pythonVersion": platform.python_version(),
    }
    log.debug("Device fingerprint: %s", fp)
    return fp

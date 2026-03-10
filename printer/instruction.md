# Qopy Printer Client — Python Microservice on Raspberry Pi

## Overview

The **Qopy Printer Client** is a production-grade Python microservice that runs on a Raspberry Pi. It connects to the Qopy cloud server via WebSocket, listens for print job signals, manages a persistent local job queue, verifies file integrity before printing, and uses CUPS (`lp`) to print. After each job, it reports the result back to the server.

---

## System Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Qopy Cloud Server                            │
│               (WebSocket + HTTP REST API)                             │
│  Sends: fileUrl + sha256 + fileSize + deviceFingerprint validation    │
└─────────────────┬─────────────────────────────────────┬──────────────┘
                  │ WebSocket (signals)     HTTP (file download)
                  ▼                                      │
┌─────────────────────────────────────────────────────────────────────┐
│                       Raspberry Pi (Python)                          │
│                                                                      │
│  ┌──────────────┐   ┌───────────────────┐   ┌──────────────────┐   │
│  │  WS Client   │──▶│  Rate Limiter     │──▶│  Queue Manager   │   │
│  │  (asyncio)   │   │  (MAX_QUEUE cap)  │   │  (SQLite + mem)  │   │
│  └──────────────┘   └───────────────────┘   └────────┬─────────┘   │
│                                                        │              │
│                                              ┌─────────▼──────────┐  │
│                                              │   Job Processor     │  │
│                                              │  ┌───────────────┐  │  │
│                                              │  │ File Type     │  │  │
│                                              │  │ Validator     │  │  │
│                                              │  ├───────────────┤  │  │
│                                              │  │ Size Check    │  │  │
│                                              │  ├───────────────┤  │  │
│                                              │  │ SHA-256 Verify│  │  │
│                                              │  ├───────────────┤  │  │
│                                              │  │ CUPS / lp     │  │  │
│                                              │  ├───────────────┤  │  │
│                                              │  │ lpstat Monitor│  │  │
│                                              │  └───────────────┘  │  │
│                                              └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## WebSocket Message Protocol

All messages are JSON objects with a `type` field.

### Client → Server

| Message Type          | When Sent                            | Key Fields                                           |
|-----------------------|--------------------------------------|------------------------------------------------------|
| `REGISTER`            | On connect                           | `deviceId`, `apiKey`, `fingerprint`                  |
| `DEVICE_STATUS`       | After register (crash recovery)      | `deviceId`, `pendingJobId` (if any)                  |
| `HEARTBEAT`           | Every 30s                            | `printerStatus`, `queueLength`, `cupsStatus`         |
| `JOB_ACCEPTED`        | Job shifted from queue               | `jobId`                                              |
| `REQUEST_JOB_DETAILS` | After accepting a job                | `jobId`                                              |
| `JOB_REJECTED`        | Queue full or invalid file           | `jobId`, `reason`                                    |
| `JOB_PRINTING`        | File verified, print started         | `jobId`                                              |
| `JOB_PROGRESS`        | During printing (page by page)       | `jobId`, `printedPages`, `totalPages`                |
| `JOB_COMPLETED`       | Print confirmed via `lpstat`         | `jobId`                                              |
| `JOB_FAILED`          | Any error during processing          | `jobId`, `message`                                   |

### Server → Client

| Message Type    | Meaning                                                      |
|-----------------|--------------------------------------------------------------|
| `REGISTERED`    | Auth OK, device fingerprint accepted                         |
| `AUTH_FAILED`   | Bad credentials or fingerprint mismatch                      |
| `NEW_JOB`       | New print job available — add to queue                       |
| `JOB_DETAILS`   | Response to `REQUEST_JOB_DETAILS` (includes `sha256`, `fileSize`) |
| `JOB_ACK`       | Server acknowledged `JOB_ACCEPTED`                           |
| `PENDING_JOB`   | Server response to `DEVICE_STATUS` (crash recovery)          |
| `HEARTBEAT_ACK` | Server acknowledged heartbeat                                |
| `ERROR`         | Server-side error                                            |

> **`JOB_DETAILS` must now include:**
> ```json
> {
>   "type": "JOB_DETAILS",
>   "jobId": "...",
>   "downloadUrl": "/api/jobs/abc/file",
>   "sha256": "e3b0c44298fc1c149afb...",
>   "fileSize": 4194304,
>   "mimeType": "application/pdf"
> }
> ```

---

## Job Lifecycle (State Machine)

```
SERVER sends NEW_JOB
        │
        ▼
  ┌─────────────────┐
  │  RATE CHECK     │  ─── if queue.size >= MAX_QUEUE → send JOB_REJECTED
  └────────┬────────┘
           │ (space in queue)
           ▼
  ┌─────────────────┐
  │  QUEUED         │  ─── persisted to SQLite, pushed to asyncio.Queue
  └────────┬────────┘
           │ (previous job finishes)
           ▼
  ┌─────────────────┐
  │  ACCEPTING      │  ─── send JOB_ACCEPTED to server
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐
  │  REQUESTING     │  ─── send REQUEST_JOB_DETAILS, await JOB_DETAILS
  └────────┬────────┘       (response contains sha256 + fileSize)
           │
           ▼
  ┌─────────────────┐
  │  SIZE CHECK     │  ─── if fileSize > MAX_FILE_SIZE → JOB_FAILED
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐
  │  FILE TYPE      │  ─── check extension + MIME → only PDF allowed
  │  VALIDATION     │
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐
  │  DOWNLOADING    │  ─── aiohttp GET → /tmp/qopy/<jobId>.pdf
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐
  │  INTEGRITY      │  ─── SHA-256 of file == expected sha256 ?
  │  CHECK          │  ─── mismatch → JOB_FAILED ("hash mismatch")
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐
  │  PRINTING       │  ─── send JOB_PRINTING, run `lp` via subprocess
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐
  │  LPSTAT VERIFY  │  ─── poll `lpstat -o` to confirm job in CUPS queue
  └────────┬────────┘        and monitor until completed/error
           │
      ┌────┴──────┐
      ▼           ▼
COMPLETED      FAILED
(JOB_COMPLETED) (JOB_FAILED + reason)
      │           │
      └─────┬─────┘
            ▼
  Delete temp file + update SQLite
            ▼
    Process next job in queue
```

---

## Project Structure

```
printer/
├── instruction.md             # This file
├── kiosk.js                   # Original Node.js agent (reference)
├── package.json
│
└── python_client/             # Python microservice
    ├── main.py                # Entry point — starts asyncio event loop
    ├── client.py              # WebSocket connection + message handler
    ├── queue_manager.py       # asyncio.Queue + SQLite persistance + rate limiting
    ├── job_processor.py       # Orchestrates: validate → download → verify → print
    ├── integrity.py           # SHA-256 verification + file type validation
    ├── printer.py             # CUPS / lp abstraction + lpstat monitoring
    ├── fingerprint.py         # Device fingerprint (MAC, serial, OS)
    ├── config.py              # Loads .env and exposes CONFIG dict
    ├── logger.py              # Logging setup (console + rotating file)
    ├── db.py                  # SQLite helpers for persistent queue
    ├── .env.example           # Template for environment variables
    └── qopy-printer.service   # systemd unit file for auto-start on Pi
```

---

## Configuration (`.env`)

```dotenv
# Server
QOPY_SERVER_WS=ws://your-server.com/ws/device
QOPY_SERVER_HTTP=http://your-server.com

# Device credentials
QOPY_DEVICE_ID=PI_KIOSK_001
QOPY_API_KEY=your_secret_key

# File limits
QOPY_MAX_FILE_SIZE_MB=20        # Reject files larger than this
QOPY_MAX_QUEUE_SIZE=10          # Reject NEW_JOB if queue is full

# Queue persistence
QOPY_DB_PATH=/var/lib/qopy/jobs.db

# Optional
QOPY_SIMULATE=0                 # Set to 1 to skip real printing (testing)
QOPY_HEARTBEAT_INTERVAL=30      # seconds
QOPY_DOWNLOAD_DIR=/tmp/qopy_downloads
QOPY_LOG_FILE=/var/log/qopy-printer.log
```

---

## Python Dependencies

```
websockets>=12.0      # async WebSocket client
aiohttp>=3.9          # async HTTP file download
aiofiles>=23.0        # async file write
python-dotenv>=1.0    # .env loader
pycups>=2.0.1         # CUPS Python bindings (lpstat + printer status)
```

Install on Raspberry Pi:

```bash
pip3 install websockets aiohttp aiofiles python-dotenv pycups
```

---

## Core Implementation Notes

### 1. Main Event Loop (`main.py`)

```python
import asyncio
from client import QopyClient

if __name__ == "__main__":
    client = QopyClient()
    asyncio.run(client.start())
```

### 2. WebSocket Client (`client.py`)

- Use `websockets.connect()` with exponential backoff reconnect loop.
- On connect: send `REGISTER` with device fingerprint, then `DEVICE_STATUS` for crash recovery.
- On `REGISTERED`: start heartbeat coroutine, query CUPS for real printer status.
- On `NEW_JOB`: pass to rate limiter before enqueuing.
- On `JOB_DETAILS`: resolve the pending `asyncio.Future`.
- Reconnect on any disconnect — exponential back-off capped at 30s.

```python
# Reconnect pattern
delay = min(3 * (2 ** attempt), 30)  # 3s → 6s → 12s → 30s max
await asyncio.sleep(delay)
```

### 3. ✅ File Integrity Verification (`integrity.py`)

**Critical security gate — always run before printing.**

```python
import hashlib

def verify_sha256(file_path: str, expected_hash: str) -> bool:
    """Verify file integrity against server-provided SHA-256 hash."""
    sha = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            sha.update(chunk)
    return sha.hexdigest() == expected_hash
```

- If `verify_sha256()` returns `False` → delete the file, send `JOB_FAILED` with reason `"hash_mismatch"`.
- Protects against: man-in-the-middle attacks, corrupted downloads, server-side bugs.

### 4. ✅ File Size Limit (`job_processor.py`)

**Check before downloading to protect Pi memory.**

```python
MAX_FILE_SIZE = int(os.getenv("QOPY_MAX_FILE_SIZE_MB", 20)) * 1024 * 1024  # bytes

async def check_file_size(details: dict) -> None:
    size = details.get("fileSize", 0)
    if size > MAX_FILE_SIZE:
        raise ValueError(
            f"File too large: {size / 1024 / 1024:.1f}MB "
            f"(limit: {MAX_FILE_SIZE // 1024 // 1024}MB)"
        )
```

- `fileSize` must be included in `JOB_DETAILS` from the server.
- Rejects the job before any download attempt.

### 5. ✅ File Type Validation (`integrity.py`)

**Only allow PDF. Reject everything else.**

```python
import mimetypes, magic  # pip install python-magic

ALLOWED_EXTENSIONS = {".pdf"}
ALLOWED_MIMES = {"application/pdf"}

def validate_file_type(file_path: str) -> None:
    """Check both extension and actual MIME type of the downloaded file."""
    ext = os.path.splitext(file_path)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise ValueError(f"Invalid file extension: {ext}")

    detected_mime = magic.from_file(file_path, mime=True)
    if detected_mime not in ALLOWED_MIMES:
        raise ValueError(f"Invalid MIME type: {detected_mime}")
```

> **Important**: Check MIME using `python-magic` (reads file magic bytes), not just the extension — an attacker could rename a shell script to `.pdf`.

Add `python-magic` to dependencies:
```bash
sudo apt install libmagic1
pip3 install python-magic
```

### 6. ✅ Improved Print Reliability (`printer.py`)

`lp` returning exit code `0` only means **"CUPS accepted the job"** — not that it printed successfully. Use `lpstat` to confirm.

```python
import asyncio, re, subprocess

async def print_file(file_path: str, config: dict) -> str:
    """Submit print job and return CUPS job ID."""
    sides = "two-sided-long-edge" if config.get("sided") == "double" else "one-sided"
    copies = str(config.get("copies", 1))
    cmd = ["lp", "-n", copies, "-o", f"sides={sides}", file_path]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
    if proc.returncode != 0:
        raise RuntimeError(f"lp submission failed: {stderr.decode()}")

    # Parse CUPS job ID from output: "request id is printer-42 (1 file(s))"
    match = re.search(r"request id is (\S+)", stdout.decode())
    if not match:
        raise RuntimeError("Could not parse CUPS job ID from lp output")
    return match.group(1)  # e.g. "HP_LaserJet-42"


async def monitor_print_job(cups_job_id: str, timeout: int = 300) -> None:
    """Poll lpstat until the job completes or errors."""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        result = subprocess.run(
            ["lpstat", "-o", cups_job_id],
            capture_output=True, text=True
        )
        output = result.stdout.strip()
        if not output:
            # Job disappeared from queue = completed
            return
        if "error" in output.lower() or "stopped" in output.lower():
            raise RuntimeError(f"CUPS job error: {output}")
        await asyncio.sleep(3)
    raise TimeoutError(f"Print job {cups_job_id} did not complete within {timeout}s")
```

**Updated job flow in `job_processor.py`:**
```python
cups_job_id = await printer.print_file(file_path, job_config)  # submit
await send({"type": "JOB_PRINTING", "jobId": job_id})
await printer.monitor_print_job(cups_job_id)                   # confirm printed
await send({"type": "JOB_COMPLETED", "jobId": job_id})
```

### 7. ✅ Crash Recovery (`client.py`)

After every reconnect and successful `REGISTERED`, send `DEVICE_STATUS`:

```python
async def on_registered(self):
    pending_job = db.get_processing_job()  # check SQLite for interrupted job
    await self.send({
        "type": "DEVICE_STATUS",
        "deviceId": CONFIG.device_id,
        "pendingJobId": pending_job["jobId"] if pending_job else None,
        "queueLength": queue_manager.size(),
    })
    # Server responds with PENDING_JOB if it wants the client to retry
```

On `PENDING_JOB` received: re-enqueue the job at the head of the queue with priority.

### 8. ✅ Persistent Job Queue (`queue_manager.py` + `db.py`)

**SQLite schema (`db.py`):**

```python
CREATE TABLE IF NOT EXISTS jobs (
    job_id      TEXT PRIMARY KEY,
    status      TEXT NOT NULL,   -- QUEUED, PROCESSING, COMPLETED, FAILED
    payload     TEXT NOT NULL,   -- JSON blob of full job data
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
```

**On startup** (`main.py`):
```python
# Restore any QUEUED jobs from last session
pending = db.get_jobs_by_status("QUEUED")
for job in pending:
    await queue_manager.enqueue(job, persist=False)  # already in DB
```

**On enqueue:**
```python
async def enqueue(self, job: dict, persist: bool = True) -> None:
    if persist:
        db.insert_job(job["jobId"], "QUEUED", job)
    await self._queue.put(job)
```

**On job state change** (PROCESSING → COMPLETED/FAILED):
```python
db.update_job_status(job_id, new_status)
```

### 9. ✅ Rate Limiting Protection (`queue_manager.py`)

```python
MAX_QUEUE = int(os.getenv("QOPY_MAX_QUEUE_SIZE", 10))

async def try_enqueue(self, job: dict) -> bool:
    if self._queue.qsize() >= MAX_QUEUE:
        return False   # Caller sends JOB_REJECTED to server
    await self.enqueue(job)
    return True
```

In the message handler:
```python
case "NEW_JOB":
    accepted = await queue_manager.try_enqueue(msg["job"])
    if not accepted:
        await send({
            "type": "JOB_REJECTED",
            "jobId": msg["job"]["jobId"],
            "reason": "queue_full"
        })
```

### 10. ✅ Real CUPS Status in Heartbeat (`printer.py`)

Instead of hardcoding `"ready"`, query CUPS via `pycups`:

```python
import cups

def get_printer_status() -> str:
    """Return real CUPS printer status string."""
    try:
        conn = cups.Connection()
        printers = conn.getPrinters()
        if not printers:
            return "no_printer"

        # Use first configured printer
        printer_name = list(printers.keys())[0]
        info = printers[printer_name]
        state = info.get("printer-state", 0)

        # CUPS state codes: 3=idle, 4=printing, 5=stopped
        return {3: "idle", 4: "printing", 5: "stopped"}.get(state, "error")
    except Exception as e:
        return "error"


def get_active_jobs() -> int:
    """Return number of jobs in CUPS queue."""
    try:
        conn = cups.Connection()
        return len(conn.getJobs())
    except Exception:
        return -1
```

Updated heartbeat message:
```python
await send({
    "type": "HEARTBEAT",
    "printerStatus": get_printer_status(),   # "idle" | "printing" | "stopped" | "error"
    "cupsJobCount": get_active_jobs(),
    "queueLength": queue_manager.size(),
    "deviceId": CONFIG.device_id,
})
```

### 11. ✅ Device Fingerprint (`fingerprint.py`)

Sent with every `REGISTER` to prevent spoofing.

```python
import uuid, subprocess, platform

def get_fingerprint() -> dict:
    """Collect hardware identifiers unique to this Pi."""

    # MAC address (most reliable cross-session)
    mac = ':'.join([
        '{:02x}'.format((uuid.getnode() >> i) & 0xff)
        for i in range(0, 48, 8)
    ][::-1])

    # Raspberry Pi serial number (from /proc/cpuinfo)
    serial = "unknown"
    try:
        with open("/proc/cpuinfo", "r") as f:
            for line in f:
                if line.startswith("Serial"):
                    serial = line.strip().split(":")[1].strip()
                    break
    except Exception:
        pass

    return {
        "macAddress": mac,
        "piSerial": serial,
        "osVersion": platform.version(),
        "hostname": platform.node(),
    }
```

Updated `REGISTER` message:
```python
await send({
    "type": "REGISTER",
    "deviceId": CONFIG.device_id,
    "apiKey": CONFIG.api_key,
    "fingerprint": get_fingerprint(),
})
```

> **Server-side**: store the fingerprint on first registration and reject future connections where `deviceId` matches but `fingerprint` differs.

### 12. Job Details Request (async Future pattern)

```python
self._details_future: asyncio.Future = None

async def request_job_details(self, job_id: str) -> dict:
    self._details_future = asyncio.get_event_loop().create_future()
    await self.send({"type": "REQUEST_JOB_DETAILS", "jobId": job_id})
    return await asyncio.wait_for(self._details_future, timeout=10)

def on_job_details(self, msg: dict):
    if self._details_future and not self._details_future.done():
        self._details_future.set_result(msg)
```

---

## Raspberry Pi Setup

### 1. Install system dependencies

```bash
sudo apt update
sudo apt install cups libmagic1
sudo usermod -aG lpadmin pi   # allow pi user to manage printers
```

Add your printer via CUPS web UI at `http://localhost:631`.

### 2. Create directories

```bash
sudo mkdir -p /var/lib/qopy /var/log
sudo chown pi:pi /var/lib/qopy
mkdir -p /tmp/qopy_downloads
```

### 3. Install Python dependencies

```bash
cd ~/qopy/printer/python_client
pip3 install websockets aiohttp aiofiles python-dotenv pycups python-magic
```

### 4. Test manually

```bash
cp .env.example .env
# Edit .env with your server URL and credentials
QOPY_SIMULATE=1 python3 main.py
```

### 5. Run as systemd service (auto-start on boot)

Create `/etc/systemd/system/qopy-printer.service`:

```ini
[Unit]
Description=Qopy Printer Client
After=network-online.target cups.service
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/qopy/printer/python_client
EnvironmentFile=/home/pi/qopy/printer/python_client/.env
ExecStart=/usr/bin/python3 main.py
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable qopy-printer
sudo systemctl start qopy-printer
sudo systemctl status qopy-printer
```

### 6. View logs

```bash
sudo journalctl -u qopy-printer -f
# Or: tail -f /var/log/qopy-printer.log
```

---

## Optional: GPIO LED Status Indicators

```python
# pip3 install RPi.GPIO
import RPi.GPIO as GPIO

PIN_READY   = 17   # Green
PIN_BUSY    = 27   # Yellow
PIN_ERROR   = 22   # Red

def set_status(status: str):
    GPIO.output(PIN_READY,  status == "idle")
    GPIO.output(PIN_BUSY,   status == "printing")
    GPIO.output(PIN_ERROR,  status in ("error", "stopped"))
```

---

## Error Handling Strategy

| Scenario                          | Action                                                        |
|-----------------------------------|---------------------------------------------------------------|
| WebSocket disconnect              | Exponential backoff reconnect (3s → 30s max)                  |
| `AUTH_FAILED`                     | Log, stop retrying until credentials fixed                    |
| Fingerprint mismatch (server)     | Treat as `AUTH_FAILED`, alert operator                        |
| Job details timeout (10s)         | `JOB_FAILED` → continue queue                                 |
| `fileSize` exceeds limit          | `JOB_FAILED` reason: `"file_too_large"` → no download        |
| Bad file extension or MIME type   | `JOB_FAILED` reason: `"invalid_file_type"` → delete file     |
| Download HTTP error               | `JOB_FAILED` reason: `"download_error"` → continue queue     |
| SHA-256 mismatch                  | `JOB_FAILED` reason: `"hash_mismatch"` → delete file         |
| `lp` submission fails             | `JOB_FAILED` reason: `"cups_error"` → continue queue         |
| `lpstat` shows printer stopped    | `JOB_FAILED` reason: `"printer_stopped"` → alert heartbeat   |
| `lpstat` monitor timeout          | `JOB_FAILED` reason: `"print_timeout"` → continue queue      |
| Queue full (`MAX_QUEUE` reached)  | `JOB_REJECTED` sent immediately, job not enqueued            |
| Pi crash mid-job                  | On restart: restore queue from SQLite, send `DEVICE_STATUS`   |
| Unexpected exception              | Log traceback, `JOB_FAILED`, continue queue                   |

---

## Security Summary

| Threat                        | Defense                                                     |
|-------------------------------|-------------------------------------------------------------|
| MITM / corrupted download     | SHA-256 integrity check before every print                  |
| Oversized file DoS            | Server must declare `fileSize`; client rejects if too large |
| Malicious file (shell/PS)     | Extension + `libmagic` MIME check — only PDF allowed        |
| Queue flooding (DoS)          | Hard cap via `MAX_QUEUE_SIZE`; `JOB_REJECTED` sent          |
| Device spoofing               | MAC + Pi serial + OS fingerprint validated on server        |
| Credential sharing            | `apiKey` + `deviceId` + `fingerprint` triple validation     |

---

## Key Differences: Python vs Node.js (`kiosk.js`)

| Aspect              | Node.js (`kiosk.js`)              | Python (new client)                          |
|---------------------|-----------------------------------|----------------------------------------------|
| Async model         | Event loop + callbacks/Promise    | `asyncio` coroutines                         |
| WebSocket lib       | `ws` npm package                  | `websockets` PyPI package                    |
| HTTP download       | `http`/`https` built-in           | `aiohttp`                                    |
| Job queue           | Plain JS array (in-memory only)   | `asyncio.Queue` + SQLite persistence         |
| Job details await   | Promise + stored resolve fn       | `asyncio.Future`                             |
| Print command       | `child_process.exec`              | `asyncio.create_subprocess_exec`             |
| Print verification  | None (lp exit code only)          | `lpstat` monitoring loop                     |
| File integrity      | None                              | SHA-256 verification against server hash     |
| File type check     | None                              | Extension + `libmagic` MIME check            |
| File size limit     | None                              | Configurable MB limit before download        |
| Rate limiting       | None                              | `MAX_QUEUE_SIZE` guard + `JOB_REJECTED`      |
| Crash recovery      | None                              | `DEVICE_STATUS` on connect + SQLite restore  |
| Printer status      | Hardcoded `"ready"`/`"busy"`      | Live CUPS query via `pycups`                 |
| Device identity     | `deviceId` only                   | `deviceId` + MAC + Pi serial + OS version    |
| Config              | `process.env`                     | `python-dotenv` + `.env` file                |
| Auto-start          | Manual / PM2                      | `systemd` service (native on Pi OS)          |
| GPIO support        | Requires `pigpio` npm             | `RPi.GPIO` (native to Pi OS)                 |

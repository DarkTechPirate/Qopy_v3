# Qopy Printer Agent

A production-grade Python microservice that runs on a **Raspberry Pi** and connects a physical printer to the Qopy cloud platform. It listens for print jobs over WebSocket, downloads and verifies files, then prints them via CUPS — reporting every state change back to the server in real time.

---

## Table of Contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Project Structure](#project-structure)
4. [How It Works](#how-it-works)
5. [WebSocket Protocol](#websocket-protocol)
6. [Prerequisites](#prerequisites)
7. [Installation](#installation)
8. [Configuration](#configuration)
9. [Running the Agent](#running-the-agent)
10. [Running as a System Service](#running-as-a-system-service)
11. [Simulation Mode](#simulation-mode)
12. [Security Features](#security-features)
13. [Module Reference](#module-reference)
14. [Logging](#logging)
15. [Troubleshooting](#troubleshooting)
16. [Environment Variable Reference](#environment-variable-reference)

---

## Features

| Capability | Detail |
|---|---|
| **Real-time communication** | WebSocket connection with auto-reconnect and exponential backoff |
| **Job queue** | Persistent in-memory + SQLite queue — survives reboots |
| **File integrity** | SHA-256 hash verified before every print |
| **File type enforcement** | Extension + `libmagic` MIME check — only PDF allowed |
| **File size limit** | Configurable MB cap — rejects before download |
| **Rate limiting** | `MAX_QUEUE_SIZE` guard, sends `JOB_REJECTED` if full |
| **Crash recovery** | Reports pending job to server on every reconnect |
| **Print verification** | Polls `lpstat` to confirm CUPS actually printed the job |
| **Live printer status** | Real CUPS status (`idle`/`printing`/`stopped`/`error`) in every heartbeat |
| **Device fingerprinting** | MAC + Pi serial + OS version sent in `REGISTER` |
| **Simulation mode** | Full dry-run without a real printer |
| **Graceful shutdown** | SIGINT / SIGTERM handled cleanly |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Qopy Cloud Server                            │
│               (WebSocket + HTTP REST API)                             │
└─────────────────┬─────────────────────────────────────┬──────────────┘
                  │ WebSocket (signals)     HTTP (file download)
                  ▼                                      │
┌─────────────────────────────────────────────────────────────────────┐
│                       Raspberry Pi (Python)                          │
│                                                                      │
│  ┌──────────┐   ┌───────────────┐   ┌──────────────────────────┐   │
│  │ client   │──▶│ queue_manager │──▶│      job_processor       │   │
│  │ (WS)     │   │ (asyncio+SQLite)│  │                          │   │
│  └──────────┘   └───────────────┘   │  1. Size check           │   │
│       │                             │  2. Download (aiohttp)    │   │
│  ┌────▼──────┐                      │  3. MIME validate         │   │
│  │ heartbeat │                      │  4. SHA-256 verify        │   │
│  │ (pycups / │                      │  5. lp submit             │   │
│  │  lpstat)  │                      │  6. lpstat monitor        │   │
│  └───────────┘                      └──────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
printer/
├── main.py                 Entry point — DB init, queue restore, SIGINT shutdown
├── client.py               WebSocket client — reconnect loop, message dispatcher
├── job_processor.py        Full 13-step print pipeline orchestrator
├── queue_manager.py        asyncio.Queue + SQLite persistence + rate limiting
├── printer.py              lp submit, lpstat monitor, CUPS live status query
├── integrity.py            SHA-256 hash check + python-magic MIME validation
├── fingerprint.py          MAC, Pi serial, OS version — sent in REGISTER
├── db.py                   SQLite CRUD helpers (WAL mode, thread-safe)
├── config.py               python-dotenv loader, typed CONFIG object
├── logger.py               Colored terminal + rotating file handler (5 MB × 3)
│
├── requirements.txt        pip dependencies
├── .env.example            Template — copy to .env, fill in your values
├── qopy-printer.service    systemd unit file (copy to /etc/systemd/system/)
├── instruction.md          Detailed architecture and design reference
├── .gitignore
└── venv/                   Python virtual environment (not committed)
```

---

## How It Works

### Job Pipeline

Every print job goes through these steps in order. If any step fails, `JOB_FAILED` is sent to the server and the agent moves to the next job:

```
Dequeue from asyncio.Queue
        │
        ▼  Send JOB_ACCEPTED
        │
        ▼  Send REQUEST_JOB_DETAILS → await server response
        │         (receives: downloadUrl, sha256, fileSize, mimeType)
        │
        ▼  CHECK: fileSize > QOPY_MAX_FILE_SIZE_MB? → JOB_FAILED
        │
        ▼  DOWNLOAD file via aiohttp (streams to /tmp/qopy_downloads/)
        │
        ▼  CHECK: file extension is .pdf? → JOB_FAILED
        ▼  CHECK: libmagic MIME = application/pdf? → JOB_FAILED
        │
        ▼  CHECK: SHA-256 hash matches server-provided sha256? → JOB_FAILED
        │
        ▼  Send JOB_PRINTING
        │
        ▼  Run: lp -n <copies> -o sides=<sided> <file>
        ▼  Parse CUPS job ID from lp output
        │
        ▼  Poll lpstat every 3s until job leaves queue (= completed)
        │         or lpstat reports error/stopped → JOB_FAILED
        │
        ▼  Send JOB_COMPLETED
        │
        ▼  Delete temp file, update SQLite, trigger next job
```

### Reconnect Logic

On every disconnect, the agent waits before retrying with exponential backoff:

```
delay = min(3 × 2^attempt, 30)
→ 3s → 6s → 12s → 24s → 30s → 30s → ...
```

On every reconnect, it sends:
1. `REGISTER` — with credentials + device fingerprint
2. `DEVICE_STATUS` — reports any interrupted job (crash recovery)

### Queue Rate Limiting

If the server sends more jobs than `QOPY_MAX_QUEUE_SIZE`:

```python
if queue.size() >= MAX_QUEUE_SIZE:
    send(JOB_REJECTED, reason="queue_full")
    return
```

---

## WebSocket Protocol

### Client → Server Messages

| Type | When | Key Fields |
|------|------|------------|
| `REGISTER` | On connect | `deviceId`, `apiKey`, `fingerprint` |
| `DEVICE_STATUS` | After register | `pendingJobId`, `queueLength`, `printerStatus` |
| `HEARTBEAT` | Every 30s | `printerStatus`, `cupsJobCount`, `queueLength` |
| `JOB_ACCEPTED` | Job dequeued | `jobId` |
| `REQUEST_JOB_DETAILS` | After accept | `jobId` |
| `JOB_REJECTED` | Queue full | `jobId`, `reason` |
| `JOB_PRINTING` | File verified | `jobId` |
| `JOB_PROGRESS` | Per page | `jobId`, `printedPages`, `totalPages` |
| `JOB_COMPLETED` | CUPS confirmed | `jobId` |
| `JOB_FAILED` | Any error | `jobId`, `message` |

### Server → Client Messages

| Type | Meaning |
|------|---------|
| `REGISTERED` | Auth OK |
| `AUTH_FAILED` | Bad credentials or fingerprint mismatch |
| `NEW_JOB` | New job — enqueue it |
| `JOB_DETAILS` | Response to `REQUEST_JOB_DETAILS` |
| `JOB_ACK` | Server acknowledged `JOB_ACCEPTED` |
| `PENDING_JOB` | Server sending back an interrupted job (crash recovery) |
| `HEARTBEAT_ACK` | Heartbeat acknowledged |
| `ERROR` | Server-side error |

### JOB_DETAILS Payload (server must include)

```json
{
  "type": "JOB_DETAILS",
  "jobId": "abc-123",
  "downloadUrl": "/api/jobs/abc-123/file",
  "sha256": "e3b0c44298fc1c14...",
  "fileSize": 4194304,
  "mimeType": "application/pdf"
}
```

---

## Prerequisites

### Hardware
- Raspberry Pi (any model with networking — 3B+ or 4 recommended)
- USB or network printer configured in CUPS

### Software
- Raspberry Pi OS (Bookworm / Bullseye) with Python 3.11+
- CUPS print server

### System Packages

```bash
sudo apt update
sudo apt install -y cups libmagic1 python3-venv

# Optional — for live CUPS status via pycups (better than lpstat fallback)
sudo apt install -y libcups2-dev
```

Allow your user to manage printers:

```bash
sudo usermod -aG lpadmin pi
```

---

## Installation

### 1. Clone / Copy the printer directory

```bash
# If part of the full Qopy repo:
git clone https://github.com/your-org/qopy.git ~/qopy
cd ~/qopy/printer

# Or just copy the printer/ folder to your Pi
```

### 2. Create the virtual environment

```bash
cd ~/qopy/printer
python3 -m venv venv
```

### 3. Install Python dependencies

```bash
venv/bin/pip install --upgrade pip
venv/bin/pip install -r requirements.txt
```

This installs:

| Package | Version | Purpose |
|---------|---------|---------|
| `websockets` | ≥ 16.0 | Async WebSocket client |
| `aiohttp` | ≥ 3.9 | Async HTTP file download |
| `aiofiles` | ≥ 23.1 | Async disk write |
| `python-dotenv` | ≥ 1.0 | Load `.env` config file |
| `python-magic` | ≥ 0.4.27 | MIME type detection via libmagic |

> **Optional**: Uncomment `pycups` in `requirements.txt` and run `pip install -r requirements.txt` again for richer CUPS status reporting. Requires `sudo apt install libcups2-dev`.

### 4. Create your `.env` file

```bash
cp .env.example .env
nano .env
```

Fill in at minimum these three **required** values:

```dotenv
QOPY_SERVER_WS=ws://your-server.com/ws/device
QOPY_DEVICE_ID=PI_KIOSK_001
QOPY_API_KEY=your_secret_api_key_here
```

### 5. Create runtime directories

```bash
sudo mkdir -p /var/lib/qopy /var/log
sudo chown pi:pi /var/lib/qopy
```

> If your user is not `pi`, replace with your actual username.

### 6. Add your printer in CUPS

Open the CUPS web UI in a browser:

```
http://<pi-ip-address>:631
```

Go to **Administration → Add Printer**, follow the wizard to add your USB or network printer.

Test it works:

```bash
echo "test page" | lp
lpstat -o   # confirm the job was accepted
```

---

## Configuration

All configuration is via environment variables, loaded from `.env`. Copy `.env.example` to `.env` to get started.

### Required Variables

| Variable | Description |
|----------|-------------|
| `QOPY_SERVER_WS` | WebSocket URL of the Qopy server, e.g. `ws://192.168.1.100:5000/ws/device` |
| `QOPY_DEVICE_ID` | Unique identifier for this kiosk, e.g. `SHOP_A_KIOSK_1` |
| `QOPY_API_KEY` | Secret API key — must match what the server expects |

### Optional Variables (with defaults)

| Variable | Default | Description |
|----------|---------|-------------|
| `QOPY_SERVER_HTTP` | `http://localhost:5000` | HTTP base URL for file downloads |
| `QOPY_SIMULATE` | `0` | Set `1` to skip real printing (testing) |
| `QOPY_HEARTBEAT_INTERVAL` | `30` | Seconds between heartbeat messages |
| `QOPY_RECONNECT_BASE` | `3` | Base reconnect delay in seconds |
| `QOPY_RECONNECT_MAX` | `30` | Max reconnect delay in seconds |
| `QOPY_MAX_FILE_SIZE_MB` | `20` | Reject files larger than this |
| `QOPY_DOWNLOAD_DIR` | `/tmp/qopy_downloads` | Temp dir for downloaded PDFs |
| `QOPY_MAX_QUEUE_SIZE` | `10` | Max jobs in queue before rejecting |
| `QOPY_DB_PATH` | `/var/lib/qopy/jobs.db` | SQLite database path |
| `QOPY_LOG_FILE` | `/var/log/qopy-printer.log` | Log file path |
| `QOPY_LOG_LEVEL` | `INFO` | `DEBUG` / `INFO` / `WARNING` / `ERROR` |
| `QOPY_JOB_DETAILS_TIMEOUT` | `10` | Seconds to wait for `JOB_DETAILS` response |
| `QOPY_PRINT_TIMEOUT` | `300` | Max seconds for a print job to complete |

---

## Running the Agent

### Manual start

```bash
cd ~/qopy/printer
venv/bin/python3 main.py
```

You'll see a startup banner like:

```
============================================================
  QOPY PRINTER AGENT
  Device : PI_KIOSK_001
  Server : ws://your-server.com/ws/device
  Simulate: NO
  DB     : /var/lib/qopy/jobs.db
============================================================
```

### Stop the agent

Press `Ctrl+C` — it will finish any in-progress job and exit cleanly.

---

## Running as a System Service

This makes the agent start automatically on boot and restart if it crashes.

### 1. Edit the service file

Open `qopy-printer.service` and confirm the paths match your setup:

```ini
User=pi                                              # your username
WorkingDirectory=/home/pi/qopy/printer               # path to this directory
EnvironmentFile=/home/pi/qopy/printer/.env           # your .env file
ExecStart=/home/pi/qopy/printer/venv/bin/python3 main.py
```

### 2. Install the service

```bash
sudo cp qopy-printer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable qopy-printer   # start on boot
sudo systemctl start qopy-printer    # start now
```

### 3. Check status

```bash
sudo systemctl status qopy-printer
```

### 4. View live logs

```bash
sudo journalctl -u qopy-printer -f
```

### 5. Stop / restart

```bash
sudo systemctl stop qopy-printer
sudo systemctl restart qopy-printer
```

---

## Simulation Mode

Run without a real printer — great for development and testing on a laptop.

```bash
QOPY_SIMULATE=1 venv/bin/python3 main.py
```

In simulation mode:
- All pipeline steps run normally (connect, queue, download, verify)
- Instead of calling `lp`, it waits **1.5s per page**
- Sends real `JOB_PROGRESS` messages to the server
- Reports `JOB_COMPLETED` at the end

You can also set `QOPY_SIMULATE=1` in your `.env` file permanently for a test environment.

---

## Security Features

| Threat | Mitigation |
|--------|-----------|
| Man-in-the-middle attack | SHA-256 hash verified after every download |
| Corrupted download | SHA-256 mismatch → `JOB_FAILED`, file deleted |
| Malicious file type | `libmagic` reads file bytes (not just extension) — only `application/pdf` accepted |
| Oversized file DoS | Server must declare `fileSize`; client rejects before downloading |
| Queue flood (DoS) | Hard cap via `QOPY_MAX_QUEUE_SIZE`; excess jobs get `JOB_REJECTED` |
| Device ID spoofing | MAC + Pi serial + OS fingerprint validated server-side |

---

## Module Reference

### `main.py`
Entry point. Initialises the database, restores any queued jobs from SQLite (crash recovery), starts the `QopyClient`, and registers signal handlers for graceful shutdown.

### `client.py`
`QopyClient` class. Manages the WebSocket connection with exponential backoff reconnect. Dispatches all incoming messages using Python 3.10+ `match/case`. Runs a background heartbeat coroutine every `QOPY_HEARTBEAT_INTERVAL` seconds.

### `job_processor.py`
`JobProcessor` class. Orchestrates the 13-step print pipeline. Uses an `asyncio.Future` to await the `JOB_DETAILS` response without blocking the WebSocket receive loop. Catches every exception category and converts them to `JOB_FAILED` messages.

### `queue_manager.py`
`QueueManager` singleton. Wraps `asyncio.Queue` with SQLite persistence and a `MAX_QUEUE_SIZE` guard. The `try_enqueue()` method returns `False` if the queue is full. `restore_from_db()` is called at startup to re-enqueue any `QUEUED` jobs from the database.

### `printer.py`
CUPS abstraction. `print_file()` submits to CUPS via `lp` and parses the CUPS job ID from the output. `monitor_print_job()` polls `lpstat -o` every 3 seconds until the job leaves the queue (completed) or reports an error. `get_printer_status()` tries `pycups` first, falls back to `lpstat -p`.

### `integrity.py`
`verify_sha256(path, expected_hash)` — computes SHA-256 in 64 KB chunks, raises `ValueError` on mismatch.
`validate_file_type(path)` — checks extension against `{".pdf"}` and MIME type against `{"application/pdf"}` using `python-magic`. Both raise `ValueError` on failure.

### `fingerprint.py`
`get_fingerprint()` — collects `macAddress` (via `uuid.getnode()`), `piSerial` (from `/proc/cpuinfo`), `piModel`, `osVersion`, `osPlatform`, `hostname`, `pythonVersion`. Returns a dict sent with every `REGISTER` message.

### `db.py`
Thread-safe SQLite wrapper (WAL journal mode). Schema has one `jobs` table:

```sql
CREATE TABLE jobs (
    job_id     TEXT PRIMARY KEY,
    status     TEXT NOT NULL,   -- QUEUED | PROCESSING | COMPLETED | FAILED
    payload    TEXT NOT NULL,   -- JSON blob
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
```

Key methods: `init()`, `insert_job()`, `update_job_status()`, `get_jobs_by_status()`, `get_processing_job()`, `delete_old_jobs(keep_n=100)`.

### `config.py`
Loads `.env` using `python-dotenv`. Exposes a single `CONFIG` singleton. Required vars (`QOPY_SERVER_WS`, `QOPY_DEVICE_ID`, `QOPY_API_KEY`) cause an immediate `sys.exit(1)` if missing, with a clear error message.

### `logger.py`
Sets up two handlers on the root logger:
- `RotatingFileHandler` — plain text, 5 MB max, 3 backups
- `StreamHandler` — ANSI coloured output for the terminal

Import with `from logger import get_logger; log = get_logger(__name__)`.

---

## Logging

Log output goes to both the terminal (coloured) and a rotating file.

**Default log file:** `/var/log/qopy-printer.log`
*(Falls back to `./qopy-printer.log` in the printer directory if `/var/log` is not writable)*

```
HH:MM:SS  INFO      client — Connected ✓
HH:MM:SS  INFO      client — Registered ✓ (server: 1.0.0)
HH:MM:SS  INFO      job_processor — Processing job: abc-123 | file: report.pdf
HH:MM:SS  INFO      job_processor — [abc-123] Accepted
HH:MM:SS  INFO      job_processor — [abc-123] File size OK: 2.1 MB
HH:MM:SS  INFO      integrity — SHA-256 OK: abc-123.pdf
HH:MM:SS  INFO      printer — CUPS job accepted: HP_LaserJet-42
HH:MM:SS  INFO      printer — CUPS job HP_LaserJet-42 completed
HH:MM:SS  INFO      job_processor — [abc-123] ✓ JOB COMPLETED
```

Change log level in `.env`:

```dotenv
QOPY_LOG_LEVEL=DEBUG   # very verbose — shows all WS messages
QOPY_LOG_LEVEL=INFO    # normal (default)
QOPY_LOG_LEVEL=WARNING # quiet — only problems
```

View live via journald (when running as service):

```bash
sudo journalctl -u qopy-printer -f
# Filter by level:
sudo journalctl -u qopy-printer -f -p warning
```

---

## Troubleshooting

### Agent won't start — "Required environment variable not set"

```bash
# Make sure .env exists and has the three required vars
cat .env | grep QOPY_SERVER_WS
cat .env | grep QOPY_DEVICE_ID
cat .env | grep QOPY_API_KEY
```

### Agent connects but `AUTH_FAILED`

- Check `QOPY_DEVICE_ID` and `QOPY_API_KEY` match what the server expects.
- If the server validates device fingerprints, it may have stored a different MAC from before — check server logs.

### Jobs are failing with "hash_mismatch"

- The downloaded file's SHA-256 does not match what the server declared in `JOB_DETAILS`.
- This is a server-side bug or a network corruption issue.
- Enable `DEBUG` logging to see both hash values.

### Jobs are failing with "invalid_file_type"

- The server is sending a file that `libmagic` does not identify as `application/pdf`.
- Only PDF files are accepted. If you need to support other types, edit `ALLOWED_MIMES` in `integrity.py`.

### `lp` works but job shows `JOB_FAILED` with "CUPS job error"

```bash
lpstat -p           # check printer is enabled
lpstat -o           # check jobs in queue
cups-config --version
sudo systemctl status cups
```

### Agent repeatedly reconnects

```bash
# Check server URL is reachable from the Pi
curl http://your-server.com/health
# Check WebSocket specifically
# (try wscat: npm install -g wscat)
wscat -c ws://your-server.com/ws/device
```

### Database permission error

```bash
sudo mkdir -p /var/lib/qopy
sudo chown pi:pi /var/lib/qopy
```

*(If still failing, the agent falls back to `./jobs.db` in the printer directory.)*

### Service won't start

```bash
sudo journalctl -u qopy-printer -n 50 --no-pager
# Check the paths in qopy-printer.service match your actual install location
```

---

## Environment Variable Reference

Complete table of all supported environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `QOPY_SERVER_WS` | ✅ | — | WebSocket server URL |
| `QOPY_DEVICE_ID` | ✅ | — | Unique device identifier |
| `QOPY_API_KEY` | ✅ | — | Authentication secret |
| `QOPY_SERVER_HTTP` | | `http://localhost:5000` | HTTP base URL for downloads |
| `QOPY_SIMULATE` | | `0` | `1` = simulate (no real printer) |
| `QOPY_HEARTBEAT_INTERVAL` | | `30` | Heartbeat frequency (seconds) |
| `QOPY_RECONNECT_BASE` | | `3` | Reconnect base delay (seconds) |
| `QOPY_RECONNECT_MAX` | | `30` | Reconnect max delay (seconds) |
| `QOPY_MAX_FILE_SIZE_MB` | | `20` | Max download file size (MB) |
| `QOPY_DOWNLOAD_DIR` | | `/tmp/qopy_downloads` | Temp download directory |
| `QOPY_MAX_QUEUE_SIZE` | | `10` | Max jobs in queue |
| `QOPY_DB_PATH` | | `/var/lib/qopy/jobs.db` | SQLite persistence path |
| `QOPY_LOG_FILE` | | `/var/log/qopy-printer.log` | Log file path |
| `QOPY_LOG_LEVEL` | | `INFO` | Log verbosity |
| `QOPY_JOB_DETAILS_TIMEOUT` | | `10` | Await timeout for JOB_DETAILS (s) |
| `QOPY_PRINT_TIMEOUT` | | `300` | Max time for CUPS to print (s) |

---

## License

Part of the Qopy platform. See the root repository for license details.

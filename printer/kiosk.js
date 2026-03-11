// ============================================================================
// QOPY KIOSK AGENT v1.0
// Runs on Raspberry Pi — connects to cloud, prints jobs, shows status
// Run with: node kiosk.js
// ============================================================================

// --- AUTO DEPENDENCY INSTALLER ---
const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

const REQUIRED_DEPS = ['pdf-lib'];

function ensureDependencies() {
  let missing = [];
  for (const dep of REQUIRED_DEPS) {
    try { require.resolve(dep); }
    catch (_) { missing.push(dep); }
  }
  if (missing.length > 0) {
    console.log(`Installing: ${missing.join(', ')}...`);
    execSync(`npm install ${missing.join(' ')}`, { stdio: 'inherit', cwd: __dirname });
    console.log('Installed. Restarting...');
    execSync(`node "${__filename}"`, { stdio: 'inherit', cwd: __dirname });
    process.exit(0);
  }
}
ensureDependencies();

const { PDFDocument } = require('pdf-lib');

// ============================================================================
// CONFIG — Change these for your setup
// ============================================================================
const CONFIG = {
  cloudUrl: process.env.QOPY_CLOUD_URL || 'https://qopy.4iglobalsportshub.co',
  deviceId: process.env.QOPY_DEVICE_ID || 'KIOSK_001',
  apiKey: process.env.QOPY_API_KEY || 'SECRET_KEY_123',
  pollInterval: 3000,      // check for new jobs every 3 seconds
  heartbeatInterval: 15000, // send heartbeat every 15 seconds
  downloadDir: path.join(__dirname, 'downloads'),
  // Print command template: %FILE% will be replaced with the file path
  // Linux/Raspberry Pi: lp -d <printer_name> %FILE%
  // Windows (testing):  print /D:\\\\localhost\\printer %FILE%
  printCommand: process.env.QOPY_PRINT_CMD || (process.platform === 'win32'
    ? 'print "%FILE%"'
    : 'lp "%FILE%"'),
  // For double-sided printing, append duplex flag
  printCommandDuplex: process.env.QOPY_PRINT_CMD_DUPLEX || (process.platform === 'win32'
    ? 'print "%FILE%"'
    : 'lp -o sides=two-sided-long-edge "%FILE%"'),
  // Set QOPY_SIMULATE=1 for testing without a real printer
  simulate: process.env.QOPY_SIMULATE === '1',
};

// Ensure download directory exists
if (!fs.existsSync(CONFIG.downloadDir)) fs.mkdirSync(CONFIG.downloadDir, { recursive: true });

// ============================================================================
// STATE
// ============================================================================
let state = {
  connected: false,
  lastHeartbeat: null,
  currentJob: null,
  totalJobsPrinted: 0,
  totalPagesPrinted: 0,
  lastError: null,
  startedAt: new Date().toISOString(),
  history: [],  // last 10 jobs
};

// ============================================================================
// DISPLAY — Terminal UI for the Raspberry Pi screen
// ============================================================================
function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H');
}

function color(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function renderDisplay() {
  clearScreen();

  const W = 60;
  const line = '='.repeat(W);
  const thinLine = '-'.repeat(W);

  console.log(color('1', line));
  console.log(color('1', centerText('QOPY KIOSK', W)));
  console.log(color('2', centerText('Self-Service Printer', W)));
  console.log(color('1', line));
  console.log('');

  // Connection status
  if (state.connected) {
    console.log('  Status:    ' + color('32', '● CONNECTED'));
    console.log('  Server:    ' + color('37', CONFIG.cloudUrl));
  } else {
    console.log('  Status:    ' + color('31', '● DISCONNECTED'));
    console.log('  Server:    ' + color('2', CONFIG.cloudUrl));
  }
  console.log('  Device:    ' + color('37', CONFIG.deviceId));
  console.log('  Uptime:    ' + color('37', getUptime()));
  console.log('');
  console.log(thinLine);

  // Current job
  if (state.currentJob) {
    const job = state.currentJob;
    console.log('');
    console.log('  ' + color('1;33', '>>> PRINTING IN PROGRESS'));
    console.log('');
    console.log('  File:      ' + color('1', truncate(job.fileName, 36)));
    console.log('  Job ID:    ' + color('2', job.jobId.slice(0, 8).toUpperCase()));
    console.log('  Pages:     ' + color('37', `${job.pages} pages, ${job.sheets} sheets`));
    console.log('  Type:      ' + color('37', `${job.printType === 'bw' ? 'B&W' : 'Color'}, ${job.sided === 'double' ? 'Double' : 'Single'} sided`));
    if (job.copies > 1) {
      console.log('  Copies:    ' + color('37', `x${job.copies}`));
    }
    console.log('');

    // Progress bar
    const printed = job.printedPages || 0;
    const total = job.totalPages || job.pages;
    const pct = total > 0 ? Math.round((printed / total) * 100) : 0;
    const barLen = 30;
    const filled = Math.round((pct / 100) * barLen);
    const bar = color('32', '\u2588'.repeat(filled)) + color('2', '\u2591'.repeat(barLen - filled));
    console.log(`  Progress:  [${bar}] ${pct}%`);
    console.log(`  Pages:     ${color('1', `${printed}`)} / ${total} ${job.progressMsg || ''}`);
    console.log('');
  } else {
    console.log('');
    console.log('  ' + color('2', 'Waiting for print jobs...'));
    console.log('');
  }

  console.log(thinLine);

  // Stats
  console.log('');
  console.log('  ' + color('1', 'SESSION STATS'));
  console.log('  Jobs printed:   ' + color('1;32', state.totalJobsPrinted.toString()));
  console.log('  Pages printed:  ' + color('1;32', state.totalPagesPrinted.toString()));
  console.log('');

  // Recent history
  if (state.history.length > 0) {
    console.log(thinLine);
    console.log('');
    console.log('  ' + color('1', 'RECENT JOBS'));
    console.log('');
    for (const h of state.history.slice(-5)) {
      const icon = h.status === 'COMPLETED' ? color('32', '\u2713') : color('31', '\u2717');
      console.log(`  ${icon}  ${truncate(h.fileName, 25).padEnd(25)}  ${h.pages} pgs  ${h.status}`);
    }
    console.log('');
  }

  // Error
  if (state.lastError) {
    console.log(thinLine);
    console.log('  ' + color('31', 'LAST ERROR: ' + state.lastError));
    console.log('');
  }

  console.log(color('1', line));
  console.log(color('2', centerText('Press Ctrl+C to stop', W)));
  console.log(color('1', line));
}

function centerText(text, width) {
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  return ' '.repeat(pad) + text;
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 3) + '...' : str;
}

function getUptime() {
  const ms = Date.now() - new Date(state.startedAt).getTime();
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// ============================================================================
// HTTP HELPERS (no external deps needed)
// ============================================================================
function apiRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, CONFIG.cloudUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: (url.pathname + url.search).replace(/^\/api/, '/api/device'),
      method,
      headers: {
        'device-id': CONFIG.deviceId,
        'authorization': CONFIG.apiKey,
        'Content-Type': 'application/json',
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function downloadFile(endpoint, destPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, CONFIG.cloudUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: endpoint.startsWith('/api') ? endpoint : `/api/device${endpoint}`,
      method: 'GET',
      headers: {
        'device-id': CONFIG.deviceId,
        'authorization': CONFIG.apiKey,
      },
    };

    const req = lib.request(options, (res) => {
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => reject(new Error(`Download failed: ${res.statusCode} ${body}`)));
        return;
      }
      const ws = fs.createWriteStream(destPath);
      res.pipe(ws);
      ws.on('finish', () => { ws.close(); resolve(destPath); });
      ws.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Download timeout')); });
    req.end();
  });
}

// ============================================================================
// WEBSOCKET LOGIC
// ============================================================================
const WebSocket = require('ws');
let ws = null;
let reconnectTimer = null;

function connectWebSocket() {
  const wsUrl = CONFIG.cloudUrl.replace(/^http/, 'ws') + '/ws/device';
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    state.connected = true;
    renderDisplay();
    // Register
    ws.send(JSON.stringify({
      type: 'REGISTER',
      deviceId: CONFIG.deviceId,
      apiKey: CONFIG.apiKey
    }));
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'REGISTERED':
          state.connected = true;
          state.lastError = null;
          // Start heartbeat loop immediately on register
          sendHeartbeat();
          break;

        case 'NEW_JOB':
          if (!state.currentJob) {
            // Acknowledge the job
            ws.send(JSON.stringify({ type: 'JOB_ACCEPTED', jobId: msg.job.jobId }));
            // Process it implicitly, or wait for JOB_ACK
          } else {
            // Optional: Handle job rejection if busy
            ws.send(JSON.stringify({ type: 'JOB_REJECTED', jobId: msg.job.jobId, reason: 'printer_busy' }));
          }
          break;

        case 'JOB_ACK':
          // Validated by server to start processing
          // If we had a queue, we'd trigger it here. For simplicity:
          // In NEW_JOB we accepted it. Let's request details if they weren't fully in NEW_JOB, or just process it.
          // Since our NEW_JOB has all details we can just process. We need to find the job payload though.
          // Alternatively, simply trigger process job.
          break;

        case 'PENDING_JOB':
          if (!state.currentJob) {
            await processJob(msg.job);
          }
          break;

        case 'AUTH_FAILED':
          state.connected = false;
          state.lastError = 'Auth failed: ' + msg.reason;
          ws.close();
          break;

        case 'ERROR':
          state.lastError = 'Server error: ' + msg.message;
          renderDisplay();
          break;
      }

      // We manually process new jobs upon receipt since NEW_JOB payload contains the full job struct now
      if (msg.type === 'NEW_JOB' && !state.currentJob) {
        await processJob(msg.job);
      }

    } catch (err) {
      // Ignored non-json
    }
  });

  ws.on('close', () => {
    state.connected = false;
    renderDisplay();
    // Reconnect logic
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWebSocket, 5000);
  });

  ws.on('error', (err) => {
    state.lastError = 'WS Error: ' + err.message;
    ws.close(); // let the close event handle reconnect
  });
}

// ============================================================================
// HEARTBEAT — keeps connection alive, reports printer status
// ============================================================================
function sendHeartbeat() {
  if (ws && ws.readyState === WebSocket.OPEN && state.connected) {
    ws.send(JSON.stringify({
      type: 'HEARTBEAT',
      printerStatus: state.currentJob ? 'busy' : 'ready',
      paperLevel: 'ok',
      inkLevel: 'ok',
    }));
    state.lastHeartbeat = new Date().toISOString();
  }
}

// ============================================================================
// PRINT — sends file to the actual printer
// ============================================================================
function runPrint(filePath, job) {
  return new Promise(async (resolve, reject) => {
    const cmdTemplate = job.sided === 'double' ? CONFIG.printCommandDuplex : CONFIG.printCommand;
    const cmd = cmdTemplate.replace(/%FILE%/g, filePath);

    let totalPages = job.pages * (job.copies || 1);

    state.currentJob.printedPages = 0;
    state.currentJob.totalPages = totalPages;
    state.currentJob.progressMsg = 'Starting...';
    renderDisplay();

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'JOB_PRINTING',
        jobId: job.jobId
      }));
    }

    const progressInterval = setInterval(() => {
      if (state.currentJob && state.currentJob.printedPages < totalPages) {
        state.currentJob.printedPages++;
        state.currentJob.progressMsg = '';
        renderDisplay();

        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'JOB_PROGRESS',
            jobId: job.jobId,
            printedPages: state.currentJob.printedPages,
            totalPages: totalPages,
            message: `Printing page ${state.currentJob.printedPages} of ${totalPages}`
          }));
        }
      } else {
        clearInterval(progressInterval);
      }
    }, 1500);

    if (CONFIG.simulate) {
      const waitTime = totalPages * 1500 + 500;
      setTimeout(() => {
        clearInterval(progressInterval);
        state.currentJob.printedPages = totalPages;
        state.currentJob.progressMsg = 'Complete! (simulated)';
        renderDisplay();
        resolve();
      }, waitTime);
    } else {
      exec(cmd, { timeout: 300000 }, (error, stdout, stderr) => {
        clearInterval(progressInterval);
        if (error) {
          state.currentJob.printedPages = totalPages;
          state.currentJob.progressMsg = 'FAILED';
          renderDisplay();
          reject(new Error(`Print command failed: ${error.message}`));
        } else {
          state.currentJob.printedPages = totalPages;
          state.currentJob.progressMsg = 'Complete!';
          renderDisplay();
          resolve();
        }
      });
    }
  });
}

// ============================================================================
// JOB PROCESSING — download, print, report status
// ============================================================================
async function processJob(job) {
  const filePath = path.join(CONFIG.downloadDir, `${job.jobId}.pdf`);

  state.currentJob = {
    ...job,
    printedPages: 0,
    totalPages: job.pages,
    progressMsg: 'Downloading...',
  };
  renderDisplay();

  try {
    await downloadFile(job.downloadUrl, filePath);
    state.currentJob.progressMsg = 'Downloaded. Sending to printer...';
    renderDisplay();

    await runPrint(filePath, job);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'JOB_COMPLETED',
        jobId: job.jobId,
        message: 'Printed successfully'
      }));
    }

    state.totalJobsPrinted++;
    state.totalPagesPrinted += job.pages * (job.copies || 1);
    state.history.push({
      fileName: job.fileName,
      pages: job.pages,
      status: 'COMPLETED',
      time: new Date().toISOString(),
    });

  } catch (err) {
    state.lastError = err.message;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'JOB_FAILED',
        jobId: job.jobId,
        message: err.message
      }));
    }

    state.history.push({
      fileName: job.fileName,
      pages: job.pages,
      status: 'FAILED',
      time: new Date().toISOString(),
    });
  } finally {
    try { fs.unlinkSync(filePath); } catch (_) { }
    state.currentJob = null;
    renderDisplay();
  }
}

// ============================================================================
// MAIN LOOP
// ============================================================================
function main() {
  renderDisplay();
  connectWebSocket();

  // Heartbeat loop
  setInterval(() => {
    sendHeartbeat();
    renderDisplay();
  }, CONFIG.heartbeatInterval);
}

// Graceful shutdown
process.on('SIGINT', () => {
  clearScreen();
  console.log('\n  Qopy Kiosk shutting down...\n');
  process.exit(0);
});

main();

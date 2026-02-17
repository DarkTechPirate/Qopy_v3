// ============================================================================
// QOPY KIOSK AGENT v2.0
// WebSocket client — connects to cloud, receives jobs, prints, reports status
// Run with: node kiosk.js
// Set QOPY_SIMULATE=1 for testing without a real printer
// ============================================================================

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');

// ============================================================================
// CONFIG
// ============================================================================
const CONFIG = {
  serverWsUrl:  process.env.QOPY_SERVER_WS  || 'ws://localhost:5000/ws/device',
  serverHttpUrl: process.env.QOPY_SERVER_HTTP || 'http://localhost:5000',
  deviceId:     process.env.QOPY_DEVICE_ID   || 'KIOSK_001',
  apiKey:       process.env.QOPY_API_KEY      || 'SECRET_KEY_123',
  heartbeatInterval: 30000,
  reconnectDelay: 3000,
  maxReconnectDelay: 30000,
  downloadDir:  path.join(__dirname, 'downloads'),
  printCommand: process.env.QOPY_PRINT_CMD || (process.platform === 'win32'
    ? 'print "%FILE%"'
    : 'lp "%FILE%"'),
  printCommandDuplex: process.env.QOPY_PRINT_CMD_DUPLEX || (process.platform === 'win32'
    ? 'print "%FILE%"'
    : 'lp -o sides=two-sided-long-edge "%FILE%"'),
  simulate: process.env.QOPY_SIMULATE === '1',
};

if (!fs.existsSync(CONFIG.downloadDir)) fs.mkdirSync(CONFIG.downloadDir, { recursive: true });

// ============================================================================
// STATE
// ============================================================================
let state = {
  connected: false,
  registered: false,
  ws: null,
  reconnectAttempts: 0,
  currentJob: null,
  jobQueue: [],
  totalJobsPrinted: 0,
  totalPagesPrinted: 0,
  lastError: null,
  startedAt: new Date().toISOString(),
  history: [],
  heartbeatTimer: null,
  // Promise resolver for REQUEST_JOB_DETAILS response
  detailsResolve: null,
  detailsReject: null,
};

// ============================================================================
// DISPLAY — Terminal UI
// ============================================================================
function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H');
}

function color(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
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

function renderDisplay() {
  clearScreen();

  const W = 60;
  const line = '='.repeat(W);
  const thinLine = '-'.repeat(W);

  console.log(color('1', line));
  console.log(color('1', centerText('QOPY KIOSK v2.0', W)));
  console.log(color('2', centerText('WebSocket Print Agent', W)));
  console.log(color('1', line));
  console.log('');

  // Connection status
  if (state.registered) {
    console.log('  Status:    ' + color('32', '● CONNECTED (WebSocket)'));
    console.log('  Server:    ' + color('37', CONFIG.serverWsUrl));
  } else if (state.connected) {
    console.log('  Status:    ' + color('33', '● REGISTERING...'));
    console.log('  Server:    ' + color('37', CONFIG.serverWsUrl));
  } else {
    console.log('  Status:    ' + color('31', '● DISCONNECTED'));
    console.log('  Server:    ' + color('2', CONFIG.serverWsUrl));
    if (state.reconnectAttempts > 0) {
      console.log('  Reconnect: ' + color('33', `Attempt #${state.reconnectAttempts}`));
    }
  }
  console.log('  Device:    ' + color('37', CONFIG.deviceId));
  console.log('  Uptime:    ' + color('37', getUptime()));
  if (CONFIG.simulate) {
    console.log('  Mode:      ' + color('33', 'SIMULATION (no real printer)'));
  }
  console.log('');
  console.log(thinLine);

  // Queue status
  if (state.jobQueue.length > 0) {
    console.log('  Queue:     ' + color('33', `${state.jobQueue.length} job(s) waiting`));
    console.log('');
  }

  // Current job
  if (state.currentJob) {
    const job = state.currentJob;
    console.log('');
    console.log('  ' + color('1;33', '>>> PRINTING IN PROGRESS'));
    console.log('');
    console.log('  File:      ' + color('1', truncate(job.fileName, 36)));
    console.log('  Job ID:    ' + color('2', job.jobId.slice(0, 8).toUpperCase()));
    console.log('  Pages:     ' + color('37', `${job.pages} pages`));
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

// ============================================================================
// WEBSOCKET CONNECTION
// ============================================================================
function connect() {
  const ws = new WebSocket(CONFIG.serverWsUrl);
  state.ws = ws;

  ws.on('open', () => {
    state.connected = true;
    state.reconnectAttempts = 0;
    renderDisplay();

    // Send REGISTER immediately
    sendMessage({
      type: 'REGISTER',
      deviceId: CONFIG.deviceId,
      apiKey: CONFIG.apiKey,
    });
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    handleMessage(msg);
  });

  ws.on('close', () => {
    state.connected = false;
    state.registered = false;
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
    renderDisplay();
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    state.lastError = 'WS error: ' + err.message;
    // 'close' event will fire after this
  });
}

function scheduleReconnect() {
  const delay = Math.min(
    CONFIG.reconnectDelay * Math.pow(2, state.reconnectAttempts),
    CONFIG.maxReconnectDelay
  );
  state.reconnectAttempts++;
  setTimeout(() => connect(), delay);
}

function sendMessage(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

// ============================================================================
// MESSAGE HANDLER
// ============================================================================
function handleMessage(msg) {
  switch (msg.type) {
    case 'REGISTERED':
      state.registered = true;
      state.lastError = null;
      // Start heartbeat
      if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = setInterval(() => {
        sendMessage({
          type: 'HEARTBEAT',
          printerStatus: state.currentJob ? 'busy' : 'ready',
          paperLevel: 'ok',
          inkLevel: 'ok',
        });
      }, CONFIG.heartbeatInterval);
      renderDisplay();
      break;

    case 'AUTH_FAILED':
      state.lastError = 'Authentication failed: ' + (msg.reason || 'unknown');
      state.registered = false;
      renderDisplay();
      break;

    case 'NEW_JOB':
      state.jobQueue.push(msg.job);
      renderDisplay();
      processNextJob();
      break;

    case 'JOB_ACK':
      // Server acknowledged our JOB_ACCEPTED
      break;

    case 'JOB_DETAILS':
      // Resolve the pending request
      if (state.detailsResolve && state.currentJob && state.currentJob.jobId === msg.jobId) {
        state.detailsResolve(msg);
        state.detailsResolve = null;
        state.detailsReject = null;
      }
      break;

    case 'HEARTBEAT_ACK':
      break;

    case 'ERROR':
      state.lastError = 'Server: ' + (msg.message || 'Unknown error');
      renderDisplay();
      break;

    default:
      break;
  }
}

// ============================================================================
// JOB PROCESSING
// ============================================================================
async function processNextJob() {
  if (state.currentJob) return;   // busy
  if (state.jobQueue.length === 0) return;  // nothing

  const job = state.jobQueue.shift();
  state.currentJob = {
    ...job,
    printedPages: 0,
    totalPages: job.pages * (job.copies || 1),
    progressMsg: 'Accepting...',
  };
  renderDisplay();

  try {
    // 1. Accept the job
    sendMessage({ type: 'JOB_ACCEPTED', jobId: job.jobId });
    state.currentJob.progressMsg = 'Accepted. Requesting details...';
    renderDisplay();

    // 2. Request job details
    const details = await requestJobDetails(job.jobId);

    // 3. Download file via HTTP
    state.currentJob.progressMsg = 'Downloading...';
    renderDisplay();
    const filePath = path.join(CONFIG.downloadDir, `${job.jobId}.pdf`);
    await downloadFile(details.downloadUrl, filePath);

    // 4. Notify server: printing started
    sendMessage({ type: 'JOB_PRINTING', jobId: job.jobId });
    state.currentJob.progressMsg = 'Sending to printer...';
    renderDisplay();

    // 5. Print
    await runPrint(filePath, job);

    // 6. Notify server: completed
    sendMessage({ type: 'JOB_COMPLETED', jobId: job.jobId, message: 'Printed successfully' });

    // Update local stats
    state.totalJobsPrinted++;
    state.totalPagesPrinted += job.pages * (job.copies || 1);
    state.history.push({
      fileName: job.fileName, pages: job.pages,
      status: 'COMPLETED', time: new Date().toISOString(),
    });

  } catch (err) {
    state.lastError = err.message;
    sendMessage({ type: 'JOB_FAILED', jobId: job.jobId, message: err.message });
    state.history.push({
      fileName: job.fileName, pages: job.pages,
      status: 'FAILED', time: new Date().toISOString(),
    });
  } finally {
    // Cleanup downloaded file
    try { fs.unlinkSync(path.join(CONFIG.downloadDir, `${job.jobId}.pdf`)); } catch (_) {}
    state.currentJob = null;
    renderDisplay();
    // Process next job in queue
    processNextJob();
  }
}

function requestJobDetails(jobId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.detailsResolve = null;
      state.detailsReject = null;
      reject(new Error('Job details request timed out'));
    }, 10000);

    state.detailsResolve = (msg) => {
      clearTimeout(timeout);
      resolve(msg);
    };
    state.detailsReject = (err) => {
      clearTimeout(timeout);
      reject(err);
    };

    sendMessage({ type: 'REQUEST_JOB_DETAILS', jobId });
  });
}

// ============================================================================
// HTTP FILE DOWNLOAD
// ============================================================================
function downloadFile(endpoint, destPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, CONFIG.serverHttpUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
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
      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => { fileStream.close(); resolve(destPath); });
      fileStream.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Download timeout')); });
    req.end();
  });
}

// ============================================================================
// PRINT
// ============================================================================
function runPrint(filePath, job) {
  return new Promise((resolve, reject) => {
    const cmdTemplate = job.sided === 'double' ? CONFIG.printCommandDuplex : CONFIG.printCommand;
    const cmd = cmdTemplate.replace(/%FILE%/g, filePath);
    const totalPages = job.pages * (job.copies || 1);

    state.currentJob.printedPages = 0;
    state.currentJob.totalPages = totalPages;
    state.currentJob.progressMsg = 'Starting...';
    renderDisplay();

    // Report start progress
    sendMessage({
      type: 'JOB_PROGRESS', jobId: job.jobId,
      printedPages: 0, totalPages, message: 'Print started',
    });

    // Simulate page-by-page progress
    const progressInterval = setInterval(() => {
      if (state.currentJob && state.currentJob.printedPages < totalPages) {
        state.currentJob.printedPages++;
        state.currentJob.progressMsg = '';
        renderDisplay();

        sendMessage({
          type: 'JOB_PROGRESS', jobId: job.jobId,
          printedPages: state.currentJob.printedPages, totalPages,
          message: `Printing page ${state.currentJob.printedPages} of ${totalPages}`,
        });
      } else {
        clearInterval(progressInterval);
      }
    }, 1500);

    if (CONFIG.simulate) {
      // SIMULATION MODE
      const waitTime = totalPages * 1500 + 500;
      setTimeout(() => {
        clearInterval(progressInterval);
        if (state.currentJob) {
          state.currentJob.printedPages = totalPages;
          state.currentJob.progressMsg = 'Complete! (simulated)';
          renderDisplay();
        }
        resolve();
      }, waitTime);
    } else {
      // REAL PRINTER
      exec(cmd, { timeout: 300000 }, (error) => {
        clearInterval(progressInterval);
        if (error) {
          if (state.currentJob) {
            state.currentJob.progressMsg = 'FAILED';
            renderDisplay();
          }
          reject(new Error(`Print command failed: ${error.message}`));
        } else {
          if (state.currentJob) {
            state.currentJob.printedPages = totalPages;
            state.currentJob.progressMsg = 'Complete!';
            renderDisplay();
          }
          resolve();
        }
      });
    }
  });
}

// ============================================================================
// MAIN
// ============================================================================
renderDisplay();
connect();

// Graceful shutdown
process.on('SIGINT', () => {
  clearScreen();
  console.log('\n  Qopy Kiosk shutting down...\n');
  if (state.ws) state.ws.close();
  process.exit(0);
});

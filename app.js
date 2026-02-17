// ============================================================================
// QOPY CLOUD PRINTING SYSTEM v1.0
// Single-file self-service printing backend + frontend
// Run with: node app.js
// ============================================================================

// --- AUTO DEPENDENCY INSTALLER ---
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REQUIRED_DEPS = ['express', 'cors', 'multer', 'uuid', 'qrcode', 'pdf-lib', 'body-parser'];

function ensureDependencies() {
  let missing = [];
  for (const dep of REQUIRED_DEPS) {
    try { require.resolve(dep); }
    catch (_) { missing.push(dep); }
  }
  if (missing.length > 0) {
    console.log(`Installing missing dependencies: ${missing.join(', ')}...`);
    execSync(`npm install ${missing.join(' ')}`, { stdio: 'inherit', cwd: __dirname });
    console.log('Dependencies installed. Restarting...');
    execSync(`node "${__filename}"`, { stdio: 'inherit', cwd: __dirname });
    process.exit(0);
  }
}
ensureDependencies();

// --- IMPORTS ---
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const { PDFDocument } = require('pdf-lib');
const bodyParser = require('body-parser');

// --- CONFIG ---
const PORT = 5000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PRICING = { bw: 3, color: 6 }; // per printed side in INR

// Registered kiosk devices
const DEVICES = [
  { deviceId: 'KIOSK_001', apiKey: 'SECRET_KEY_123', name: 'Main Kiosk', location: 'Ground Floor' }
];

// --- ENSURE UPLOAD FOLDER ---
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- IN-MEMORY STORES ---
let jobs = [];       // all print jobs
let payments = [];   // payment records

// --- MULTER CONFIG ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = uuidv4();
    const ext = path.extname(file.originalname);
    cb(null, `${unique}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  }
});

// --- EXPRESS APP ---
const app = express();
app.use(cors({
  origin: '*', // Allow all origins for now; restrict to your Netlify domain in production
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'device-id', 'authorization']
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ============================================================================
// API ROUTES
// ============================================================================

// --- 1. UPLOAD PDF ---
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const filePath = req.file.path;
    const fileBuffer = fs.readFileSync(filePath);
    const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
    const pageCount = pdfDoc.getPageCount();

    const jobId = uuidv4();
    const job = {
      jobId,
      fileName: req.file.originalname,
      filePath,
      storedName: req.file.filename,
      pages: pageCount,
      printType: null,      // 'bw' or 'color'
      sided: null,          // 'single' or 'double'
      copies: 1,
      sheets: null,
      pricePerSide: null,
      totalAmount: null,
      deviceId: 'KIOSK_001', // default device for MVP
      status: 'AWAITING_OPTIONS',
      paymentId: null,
      printedPages: 0,
      printProgress: null,  // e.g. "Printing page 3 of 10"
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    jobs.push(job);

    res.json({
      success: true,
      jobId,
      fileName: req.file.originalname,
      pages: pageCount
    });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: 'Failed to process PDF: ' + err.message });
  }
});

// --- 2. SET OPTIONS AND CALCULATE PRICE ---
app.post('/api/job/options', (req, res) => {
  const { jobId, printType, sided, copies } = req.body;
  const job = jobs.find(j => j.jobId === jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'AWAITING_OPTIONS') return res.status(400).json({ error: 'Options already set' });

  if (!['bw', 'color'].includes(printType)) return res.status(400).json({ error: 'Invalid printType (bw or color)' });
  if (!['single', 'double'].includes(sided)) return res.status(400).json({ error: 'Invalid sided (single or double)' });

  const numCopies = Math.max(1, parseInt(copies) || 1);
  const pricePerSide = PRICING[printType];

  let sheets, totalSides;
  if (sided === 'double') {
    sheets = Math.ceil(job.pages / 2);
    totalSides = job.pages; // charge per printed side, not per sheet
  } else {
    sheets = job.pages;
    totalSides = job.pages;
  }

  // For double-sided: charge per sheet (each sheet has 2 sides printed but cost is per sheet)
  // Clarification: ₹3 per page means per physical sheet for double-sided
  let totalAmount;
  if (sided === 'double') {
    totalAmount = sheets * pricePerSide * numCopies;
  } else {
    totalAmount = sheets * pricePerSide * numCopies;
  }

  job.printType = printType;
  job.sided = sided;
  job.copies = numCopies;
  job.sheets = sheets;
  job.pricePerSide = pricePerSide;
  job.totalAmount = totalAmount;
  job.status = 'AWAITING_PAYMENT';
  job.updatedAt = new Date().toISOString();

  res.json({
    success: true,
    jobId,
    pages: job.pages,
    sheets,
    printType,
    sided,
    copies: numCopies,
    pricePerSide,
    totalAmount
  });
});

// --- 3. GENERATE PAYMENT QR ---
app.get('/api/payment/qr/:jobId', async (req, res) => {
  const job = jobs.find(j => j.jobId === req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'AWAITING_PAYMENT') return res.status(400).json({ error: 'Job not awaiting payment' });

  // UPI deep link format
  const upiId = 'qopy@upi'; // replace with real UPI ID later
  const payeeName = 'Qopy Printing';
  const upiLink = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(payeeName)}&am=${job.totalAmount}&cu=INR&tn=Print-${job.jobId.slice(0, 8)}`;

  try {
    const qrDataUrl = await QRCode.toDataURL(upiLink, { width: 300, margin: 2, color: { dark: '#000000', light: '#FFFFFF' } });
    res.json({
      success: true,
      jobId: job.jobId,
      amount: job.totalAmount,
      qrCode: qrDataUrl,
      upiLink
    });
  } catch (err) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// --- 4. CONFIRM PAYMENT (SIMULATED) ---
app.post('/api/payment/confirm', (req, res) => {
  const { jobId } = req.body;
  const job = jobs.find(j => j.jobId === jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'AWAITING_PAYMENT') return res.status(400).json({ error: 'Job not awaiting payment' });

  const paymentId = 'PAY_' + uuidv4().slice(0, 12).toUpperCase();
  job.paymentId = paymentId;
  job.status = 'PAID';
  job.updatedAt = new Date().toISOString();

  payments.push({
    paymentId,
    jobId: job.jobId,
    amount: job.totalAmount,
    method: 'UPI_SIMULATED',
    confirmedAt: new Date().toISOString()
  });

  res.json({
    success: true,
    jobId: job.jobId,
    paymentId,
    status: 'PAID',
    message: 'Payment confirmed. Your file is queued for printing.'
  });
});

// --- 5. JOB STATUS CHECK ---
app.get('/api/job/status/:jobId', (req, res) => {
  const job = jobs.find(j => j.jobId === req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    jobId: job.jobId,
    fileName: job.fileName,
    pages: job.pages,
    sheets: job.sheets,
    printType: job.printType,
    sided: job.sided,
    copies: job.copies,
    totalAmount: job.totalAmount,
    status: job.status,
    paymentId: job.paymentId,
    printedPages: job.printedPages || 0,
    printProgress: job.printProgress || null,
    deviceId: job.deviceId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  });
});

// ============================================================================
// DEVICE (RASPBERRY PI) API
// ============================================================================

// Middleware to authenticate device requests
function authenticateDevice(req, res, next) {
  const deviceId = req.headers['device-id'];
  const authKey = req.headers['authorization'];
  if (!deviceId || !authKey) return res.status(401).json({ error: 'Missing device credentials' });

  const device = DEVICES.find(d => d.deviceId === deviceId && d.apiKey === authKey);
  if (!device) return res.status(403).json({ error: 'Invalid device credentials' });

  req.device = device;
  next();
}

// --- 6. DEVICE POLLS FOR JOBS (only PAID jobs) ---
app.get('/api/device/jobs', authenticateDevice, (req, res) => {
  const pendingJob = jobs.find(j => j.deviceId === req.device.deviceId && j.status === 'PAID');
  if (!pendingJob) return res.json({ hasJob: false });

  res.json({
    hasJob: true,
    job: {
      jobId: pendingJob.jobId,
      fileName: pendingJob.fileName,
      pages: pendingJob.pages,
      sheets: pendingJob.sheets,
      printType: pendingJob.printType,
      sided: pendingJob.sided,
      copies: pendingJob.copies,
      downloadUrl: `/api/device/download/${pendingJob.jobId}`
    }
  });
});

// --- 7. DEVICE DOWNLOADS FILE (only if PAID) ---
app.get('/api/device/download/:jobId', authenticateDevice, (req, res) => {
  const job = jobs.find(j => j.jobId === req.params.jobId && j.deviceId === req.device.deviceId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'PAID') return res.status(403).json({ error: 'Job not paid or already processed' });

  // Mark as printing once download starts
  job.status = 'PRINTING';
  job.updatedAt = new Date().toISOString();

  res.download(job.filePath, job.fileName);
});

// --- 8. DEVICE UPDATES JOB STATUS ---
app.post('/api/device/job-update', authenticateDevice, (req, res) => {
  const { jobId, status, message } = req.body;
  const job = jobs.find(j => j.jobId === jobId && j.deviceId === req.device.deviceId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const validTransitions = {
    'PRINTING': ['COMPLETED', 'FAILED'],
    'PAID': ['PRINTING']
  };

  if (!validTransitions[job.status] || !validTransitions[job.status].includes(status)) {
    return res.status(400).json({ error: `Cannot transition from ${job.status} to ${status}` });
  }

  job.status = status;
  job.statusMessage = message || null;
  job.updatedAt = new Date().toISOString();
  if (status === 'COMPLETED') {
    job.completedAt = new Date().toISOString();
    // Auto-delete the uploaded file after successful print
    if (job.filePath && fs.existsSync(job.filePath)) {
      fs.unlink(job.filePath, (err) => {
        if (err) console.error('File cleanup failed:', err.message);
        else console.log(`Cleaned up file for job ${jobId}`);
      });
      job.filePath = null;
    }
  }

  res.json({ success: true, jobId, status });
});

// --- 8b. DEVICE REPORTS PRINT PROGRESS (page-by-page) ---
app.post('/api/device/job-progress', authenticateDevice, (req, res) => {
  const { jobId, printedPages, totalPages, message } = req.body;
  const job = jobs.find(j => j.jobId === jobId && j.deviceId === req.device.deviceId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'PRINTING') return res.status(400).json({ error: 'Job not in PRINTING state' });

  job.printedPages = printedPages || 0;
  job.printProgress = message || `Printing page ${printedPages} of ${totalPages}`;
  job.updatedAt = new Date().toISOString();

  res.json({ success: true, jobId, printedPages, totalPages });
});

// --- 9. DEVICE HEARTBEAT ---
app.post('/api/device/heartbeat', authenticateDevice, (req, res) => {
  req.device.lastSeen = new Date().toISOString();
  req.device.printerStatus = req.body.printerStatus || 'unknown';
  req.device.paperLevel = req.body.paperLevel || 'unknown';
  req.device.inkLevel = req.body.inkLevel || 'unknown';
  res.json({ success: true, serverTime: new Date().toISOString() });
});

// ============================================================================
// ADMIN API
// ============================================================================

app.get('/api/admin/jobs', (req, res) => {
  res.json({
    total: jobs.length,
    jobs: jobs.map(j => ({
      jobId: j.jobId,
      fileName: j.fileName,
      pages: j.pages,
      printType: j.printType,
      sided: j.sided,
      copies: j.copies,
      totalAmount: j.totalAmount,
      status: j.status,
      paymentId: j.paymentId,
      deviceId: j.deviceId,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt
    }))
  });
});

app.get('/api/admin/devices', (req, res) => {
  res.json({
    devices: DEVICES.map(d => ({
      deviceId: d.deviceId,
      name: d.name,
      location: d.location,
      lastSeen: d.lastSeen || 'Never',
      printerStatus: d.printerStatus || 'unknown',
      paperLevel: d.paperLevel || 'unknown',
      inkLevel: d.inkLevel || 'unknown'
    }))
  });
});

app.get('/api/admin/stats', (req, res) => {
  const stats = {
    totalJobs: jobs.length,
    awaitingOptions: jobs.filter(j => j.status === 'AWAITING_OPTIONS').length,
    awaitingPayment: jobs.filter(j => j.status === 'AWAITING_PAYMENT').length,
    paid: jobs.filter(j => j.status === 'PAID').length,
    printing: jobs.filter(j => j.status === 'PRINTING').length,
    completed: jobs.filter(j => j.status === 'COMPLETED').length,
    failed: jobs.filter(j => j.status === 'FAILED').length,
    totalRevenue: payments.reduce((sum, p) => sum + p.amount, 0),
    totalPayments: payments.length
  };
  res.json(stats);
});

// ============================================================================
// FRONTEND — React app hosted on Netlify, this serves API only
// ============================================================================

app.get('/', (req, res) => {
  res.json({ service: 'Qopy Cloud Printing System', version: '1.0', status: 'running' });
});

// ============================================================================
// ADMIN FRONTEND
// ============================================================================

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Qopy Admin</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    background: #FFF;
    color: #000;
    min-height: 100vh;
  }
  .header {
    border-bottom: 2px solid #000;
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .header h1 { font-size: 22px; font-weight: 800; }
  .header a { color: #666; font-size: 13px; text-decoration: none; }
  .content { max-width: 960px; margin: 0 auto; padding: 24px 20px; }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 12px;
    margin-bottom: 28px;
  }
  .stat-card {
    border: 2px solid #000;
    border-radius: 6px;
    padding: 14px;
    text-align: center;
  }
  .stat-value { font-size: 28px; font-weight: 800; }
  .stat-label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }

  h2 { font-size: 18px; margin-bottom: 14px; }

  .table-wrap { overflow-x: auto; margin-bottom: 28px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 10px 8px; border-bottom: 2px solid #000; font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
  td { padding: 10px 8px; border-bottom: 1px solid #EEE; }
  tr:hover td { background: #F8F8F8; }

  .status-badge {
    display: inline-block;
    padding: 3px 8px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .status-AWAITING_OPTIONS { background: #F0F0F0; color: #666; }
  .status-AWAITING_PAYMENT { background: #E8E8E8; color: #444; }
  .status-PAID { background: #DDD; color: #000; }
  .status-PRINTING { background: #333; color: #FFF; }
  .status-COMPLETED { background: #000; color: #FFF; }
  .status-FAILED { background: #777; color: #FFF; }

  .device-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 12px;
  }
  .device-card {
    border: 2px solid #000;
    border-radius: 6px;
    padding: 16px;
  }
  .device-name { font-weight: 700; font-size: 16px; }
  .device-info { font-size: 13px; color: #666; margin-top: 6px; }
  .device-info div { margin-top: 3px; }

  .refresh-btn {
    padding: 8px 16px;
    border: 2px solid #000;
    background: #000;
    color: #FFF;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    border-radius: 4px;
  }
  .refresh-btn:hover { background: #333; }

  .empty { color: #999; font-style: italic; padding: 24px; text-align: center; }
</style>
</head>
<body>

<div class="header">
  <h1>QOPY Admin</h1>
  <div>
    <button class="refresh-btn" onclick="loadAll()">Refresh</button>
    &nbsp;
    <a href="/">&#8592; Main Site</a>
  </div>
</div>

<div class="content">
  <div class="stats-grid" id="statsGrid"></div>

  <h2>Devices</h2>
  <div class="device-cards" id="devicesContainer"></div>

  <h2 style="margin-top:28px;">Print Jobs</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Job ID</th>
          <th>File</th>
          <th>Pages</th>
          <th>Type</th>
          <th>Sides</th>
          <th>Copies</th>
          <th>Amount</th>
          <th>Status</th>
          <th>Device</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody id="jobsTableBody"></tbody>
    </table>
    <div class="empty" id="noJobs">No jobs yet.</div>
  </div>
</div>

<script>
async function loadAll() {
  // Stats
  try {
    const sRes = await fetch('/api/admin/stats');
    const stats = await sRes.json();
    document.getElementById('statsGrid').innerHTML = [
      { v: stats.totalJobs, l: 'Total Jobs' },
      { v: stats.awaitingPayment, l: 'Awaiting Pay' },
      { v: stats.paid, l: 'Paid' },
      { v: stats.printing, l: 'Printing' },
      { v: stats.completed, l: 'Completed' },
      { v: stats.failed, l: 'Failed' },
      { v: '\\u20B9' + stats.totalRevenue, l: 'Revenue' }
    ].map(s => '<div class="stat-card"><div class="stat-value">' + s.v + '</div><div class="stat-label">' + s.l + '</div></div>').join('');
  } catch (_) {}

  // Devices
  try {
    const dRes = await fetch('/api/admin/devices');
    const dData = await dRes.json();
    document.getElementById('devicesContainer').innerHTML = dData.devices.map(d =>
      '<div class="device-card">' +
        '<div class="device-name">' + d.name + '</div>' +
        '<div class="device-info">' +
          '<div>ID: ' + d.deviceId + '</div>' +
          '<div>Location: ' + d.location + '</div>' +
          '<div>Printer: ' + d.printerStatus + '</div>' +
          '<div>Last Seen: ' + (d.lastSeen === 'Never' ? 'Never' : new Date(d.lastSeen).toLocaleString()) + '</div>' +
        '</div>' +
      '</div>'
    ).join('');
  } catch (_) {}

  // Jobs
  try {
    const jRes = await fetch('/api/admin/jobs');
    const jData = await jRes.json();
    if (jData.jobs.length === 0) {
      document.getElementById('noJobs').style.display = 'block';
      document.getElementById('jobsTableBody').innerHTML = '';
    } else {
      document.getElementById('noJobs').style.display = 'none';
      document.getElementById('jobsTableBody').innerHTML = jData.jobs.reverse().map(j =>
        '<tr>' +
          '<td style="font-family:monospace;">' + j.jobId.slice(0,8).toUpperCase() + '</td>' +
          '<td>' + (j.fileName || '-') + '</td>' +
          '<td>' + (j.pages || '-') + '</td>' +
          '<td>' + (j.printType === 'bw' ? 'B&W' : j.printType === 'color' ? 'Color' : '-') + '</td>' +
          '<td>' + (j.sided || '-') + '</td>' +
          '<td>' + (j.copies || '-') + '</td>' +
          '<td>' + (j.totalAmount != null ? '\\u20B9' + j.totalAmount : '-') + '</td>' +
          '<td><span class="status-badge status-' + j.status + '">' + j.status.replace(/_/g, ' ') + '</span></td>' +
          '<td>' + (j.deviceId || '-') + '</td>' +
          '<td>' + new Date(j.createdAt).toLocaleString() + '</td>' +
        '</tr>'
      ).join('');
    }
  } catch (_) {}
}

loadAll();
setInterval(loadAll, 5000);
</script>
</body>
</html>`;

app.get('/admin', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(ADMIN_HTML);
});

// ============================================================================
// ERROR HANDLER
// ============================================================================
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large. Max 50MB.' });
    return res.status(400).json({ error: err.message });
  }
  if (err.message === 'Only PDF files are allowed') {
    return res.status(400).json({ error: err.message });
  }
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================================
// START SERVER
// ============================================================================
app.listen(PORT, () => {
  console.log('');
  console.log('  ================================================================');
  console.log('  QOPY Cloud Printing System v1.0');
  console.log('  ================================================================');
  console.log('');
  console.log('  Main Site:  http://localhost:' + PORT);
  console.log('  Admin:      http://localhost:' + PORT + '/admin');
  console.log('');
  console.log('  Device API: http://localhost:' + PORT + '/api/device/jobs');
  console.log('  Device ID:  KIOSK_001');
  console.log('  API Key:    SECRET_KEY_123');
  console.log('');
  console.log('  ================================================================');
  console.log('  Status: RUNNING');
  console.log('  ================================================================');
  console.log('');
});

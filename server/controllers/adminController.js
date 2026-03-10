const Job = require('../models/Job');
const Payment = require('../models/Payment');
const Admin = require('../models/Admin');
const Device = require('../models/Device');
const config = require('../config');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ----------------------------------------
// AUTHENTICATION
// ----------------------------------------
const login = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Please enter all fields' });
  }

  try {
    const admin = await Admin.findOne({ username });
    if (!admin) return res.status(400).json({ error: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid credentials' });

    const payload = { id: admin.id, username: admin.username };
    const secret = process.env.JWT_SECRET || 'qopy_super_secret_key';

    jwt.sign(payload, secret, { expiresIn: '1d' }, (err, token) => {
      if (err) throw err;
      res.json({ token, user: payload });
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// ----------------------------------------
// DATA FETCHER (Requires Auth Wrapper route)
// ----------------------------------------
const getAdminJobs = async (req, res) => {
  try {
    const jobs = await Job.find().sort({ createdAt: -1 });
    res.json({
      total: jobs.length,
      jobs
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
};

const getAdminDevices = async (req, res) => {
  try {
    const devices = await Device.find();
    res.json({
      devices: devices.map(d => ({
        deviceId: d.deviceId,
        name: d.name,
        location: d.location,
        lastSeen: d.lastSeen || 'Never',
        printerStatus: d.printerStatus || 'unknown',
        paperLevel: d.paperLevel || 'unknown',
        inkLevel: d.inkLevel || 'unknown'
      }))
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
};

const getAdminStats = async (req, res) => {
  try {
    const totalJobs = await Job.countDocuments();
    const awaitingOptions = await Job.countDocuments({ status: 'AWAITING_OPTIONS' });
    const awaitingPayment = await Job.countDocuments({ status: 'AWAITING_PAYMENT' });
    const paid = await Job.countDocuments({ status: 'PAID' });
    const printing = await Job.countDocuments({ status: 'PRINTING' });
    const completed = await Job.countDocuments({ status: 'COMPLETED' });
    const failed = await Job.countDocuments({ status: 'FAILED' });

    const payments = await Payment.find();
    const totalRevenue = payments.reduce((sum, p) => sum + p.amount, 0);

    res.json({
      totalJobs,
      awaitingOptions,
      awaitingPayment,
      paid,
      printing,
      completed,
      failed,
      totalRevenue,
      totalPayments: payments.length
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
};

// ----------------------------------------
// RENDER HTML
// ----------------------------------------
const renderAdminHtml = () => {
  return `<!DOCTYPE html>
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
  .header button, .header a { background: none; border: none; font-weight: bold; cursor: pointer; color: #666; font-size: 13px; text-decoration: none; }
  .header button:hover, .header a:hover { color: #000; }
  
  .content { max-width: 960px; margin: 0 auto; padding: 24px 20px; }

  /* Login Form Styles */
  #loginScreen {
    display: none;
    max-width: 320px;
    margin: 80px auto;
    border: 2px solid #000;
    border-radius: 6px;
    padding: 24px;
  }
  #loginScreen h2 { text-align: center; margin-bottom: 16px; font-size: 20px; }
  .form-group { margin-bottom: 12px; }
  .form-group label { display: block; font-size: 12px; font-weight: bold; margin-bottom: 4px; }
  .form-group input { width: 100%; padding: 8px; border: 1px solid #CCC; border-radius: 4px; }
  .btn { width: 100%; padding: 10px; background: #000; color: #FFF; border: none; font-weight: bold; cursor: pointer; border-radius: 4px; }
  .btn:hover { background: #333; }
  #loginError { color: red; font-size: 12px; text-align: center; margin-top: 8px; display: none; }

  /* Dashboard Styles */
  #dashboardScreen { display: none; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-bottom: 28px; }
  .stat-card { border: 2px solid #000; border-radius: 6px; padding: 14px; text-align: center; }
  .stat-value { font-size: 28px; font-weight: 800; }
  .stat-label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
  h2 { font-size: 18px; margin-bottom: 14px; }
  .table-wrap { overflow-x: auto; margin-bottom: 28px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 10px 8px; border-bottom: 2px solid #000; font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
  td { padding: 10px 8px; border-bottom: 1px solid #EEE; }
  tr:hover td { background: #F8F8F8; }
  .status-badge { display: inline-block; padding: 3px 8px; border-radius: 3px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
  .status-AWAITING_OPTIONS { background: #F0F0F0; color: #666; }
  .status-AWAITING_PAYMENT { background: #E8E8E8; color: #444; }
  .status-PAID { background: #DDD; color: #000; }
  .status-PRINTING { background: #333; color: #FFF; }
  .status-COMPLETED { background: #000; color: #FFF; }
  .status-FAILED { background: #777; color: #FFF; }
  
  .device-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 12px; }
  .device-card { border: 2px solid #000; border-radius: 6px; padding: 16px; }
  .device-name { font-weight: 700; font-size: 16px; }
  .device-info { font-size: 13px; color: #666; margin-top: 6px; }
  .device-info div { margin-top: 3px; }
  .refresh-btn { padding: 8px 16px; border: 2px solid #000; background: #000; color: #FFF; font-size: 13px; font-weight: 600; cursor: pointer; border-radius: 4px; }
  .refresh-btn:hover { background: #333; }
  .empty { color: #999; font-style: italic; padding: 24px; text-align: center; }
</style>
</head>
<body>

<div class="header">
  <h1>QOPY Admin</h1>
  <div id="headerActions" style="display:none;">
    <button class="refresh-btn" onclick="loadAll()" style="color:#FFF;">Refresh</button>
    &nbsp;&nbsp;
    <button onclick="logout()">Logout</button>
  </div>
</div>

<div class="content">

  <!-- LOGIN SCREEN -->
  <div id="loginScreen">
    <h2>Admin Login</h2>
    <div class="form-group">
      <label>Username</label>
      <input type="text" id="username" placeholder="Enter username">
    </div>
    <div class="form-group">
      <label>Password</label>
      <input type="password" id="password" placeholder="Enter password">
    </div>
    <button class="btn" onclick="attemptLogin()">Login</button>
    <div id="loginError">Invalid credentials</div>
  </div>

  <!-- DASHBOARD APP -->
  <div id="dashboardScreen">
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

</div>

<script>
  // Auth State
  let token = localStorage.getItem('qopy_admin_token');

  function init() {
    if (token) {
      document.getElementById('loginScreen').style.display = 'none';
      document.getElementById('dashboardScreen').style.display = 'block';
      document.getElementById('headerActions').style.display = 'block';
      loadAll();
      setInterval(loadAll, 10000); // Polling every 10s if authed
    } else {
      document.getElementById('loginScreen').style.display = 'block';
      document.getElementById('dashboardScreen').style.display = 'none';
      document.getElementById('headerActions').style.display = 'none';
    }
  }

  async function attemptLogin() {
    const u = document.getElementById('username').value;
    const p = document.getElementById('password').value;
    document.getElementById('loginError').style.display = 'none';

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
      });
      const data = await res.json();
      if (res.ok && data.token) {
        token = data.token;
        localStorage.setItem('qopy_admin_token', token);
        init();
      } else {
        document.getElementById('loginError').innerText = data.error || 'Login Failed';
        document.getElementById('loginError').style.display = 'block';
      }
    } catch(err) {
      document.getElementById('loginError').innerText = 'Server Error';
      document.getElementById('loginError').style.display = 'block';
    }
  }

  function logout() {
    localStorage.removeItem('qopy_admin_token');
    token = null;
    init();
  }

  // Authenticated Fetch Wrapper
  async function authFetch(url) {
    const res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (res.status === 401 || res.status === 403) {
      logout();
      throw new Error('Unauthorized');
    }
    return res.json();
  }

  async function loadAll() {
    if(!token) return;

    try {
      const stats = await authFetch('/api/admin/stats');
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

    try {
      const dData = await authFetch('/api/admin/devices');
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

    try {
      const jData = await authFetch('/api/admin/jobs');
      if (jData.jobs.length === 0) {
        document.getElementById('noJobs').style.display = 'block';
        document.getElementById('jobsTableBody').innerHTML = '';
      } else {
        document.getElementById('noJobs').style.display = 'none';
        document.getElementById('jobsTableBody').innerHTML = jData.jobs.map(j =>
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

  // Start app
  init();
</script>
</body>
</html>`;
};

const getAdminHtml = (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(renderAdminHtml());
};

module.exports = {
  login,
  getAdminJobs,
  getAdminDevices,
  getAdminStats,
  getAdminHtml
};

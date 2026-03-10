const router = require('express').Router();
const PrintJob = require('../models/PrintJob');
const Device = require('../models/Device');
const Payment = require('../models/Payment');

router.get('/api/admin/stats', async (req, res) => {
  try {
    const [totalJobs, notPaid, paid, assigned, printing, completed, failed] = await Promise.all([
      PrintJob.countDocuments(),
      PrintJob.countDocuments({ status: 'NOT_PAID' }),
      PrintJob.countDocuments({ status: 'PAID' }),
      PrintJob.countDocuments({ status: 'ASSIGNED' }),
      PrintJob.countDocuments({ status: 'PRINTING' }),
      PrintJob.countDocuments({ status: 'COMPLETED' }),
      PrintJob.countDocuments({ status: 'FAILED' }),
    ]);
    const revenueResult = await Payment.aggregate([
      { $match: { status: 'CONFIRMED' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const totalRevenue = revenueResult.length > 0 ? revenueResult[0].total : 0;
    const totalPayments = await Payment.countDocuments({ status: 'CONFIRMED' });

    res.json({ totalJobs, notPaid, paid, assigned, printing, completed, failed, totalRevenue, totalPayments });
  } catch (err) {
    res.status(500).json({ error: 'Stats failed' });
  }
});

router.get('/api/admin/devices', async (req, res) => {
  try {
    const devices = await Device.find({}, 'deviceId name location isOnline lastSeen printerStatus paperLevel inkLevel');
    res.json({ devices });
  } catch (err) {
    res.status(500).json({ error: 'Devices fetch failed' });
  }
});

router.get('/api/admin/jobs', async (req, res) => {
  try {
    const jobs = await PrintJob.find().sort({ createdAt: -1 }).limit(100);
    res.json({ total: jobs.length, jobs });
  } catch (err) {
    res.status(500).json({ error: 'Jobs fetch failed' });
  }
});

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
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
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
  .status-NOT_PAID { background: #F0F0F0; color: #666; }
  .status-PAID { background: #DDD; color: #000; }
  .status-ASSIGNED { background: #555; color: #FFF; }
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
  .online-badge { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 10px; font-weight: 700; text-transform: uppercase; margin-left: 8px; }
  .online-true { background: #000; color: #FFF; }
  .online-false { background: #EEE; color: #999; }

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
    <a href="/">&#8592; API</a>
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
  try {
    const sRes = await fetch('/api/admin/stats');
    const stats = await sRes.json();
    document.getElementById('statsGrid').innerHTML = [
      { v: stats.totalJobs, l: 'Total Jobs' },
      { v: stats.notPaid, l: 'Not Paid' },
      { v: stats.paid, l: 'Paid' },
      { v: stats.assigned, l: 'Assigned' },
      { v: stats.printing, l: 'Printing' },
      { v: stats.completed, l: 'Completed' },
      { v: stats.failed, l: 'Failed' },
      { v: '\\u20B9' + stats.totalRevenue, l: 'Revenue' }
    ].map(s => '<div class="stat-card"><div class="stat-value">' + s.v + '</div><div class="stat-label">' + s.l + '</div></div>').join('');
  } catch (_) {}

  try {
    const dRes = await fetch('/api/admin/devices');
    const dData = await dRes.json();
    document.getElementById('devicesContainer').innerHTML = dData.devices.map(d =>
      '<div class="device-card">' +
        '<div class="device-name">' + d.name + '<span class="online-badge online-' + d.isOnline + '">' + (d.isOnline ? 'ONLINE' : 'OFFLINE') + '</span></div>' +
        '<div class="device-info">' +
          '<div>ID: ' + d.deviceId + '</div>' +
          '<div>Location: ' + (d.location || '-') + '</div>' +
          '<div>Printer: ' + d.printerStatus + '</div>' +
          '<div>Last Seen: ' + (d.lastSeen ? new Date(d.lastSeen).toLocaleString() : 'Never') + '</div>' +
        '</div>' +
      '</div>'
    ).join('');
  } catch (_) {}

  try {
    const jRes = await fetch('/api/admin/jobs');
    const jData = await jRes.json();
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

loadAll();
setInterval(loadAll, 5000);
</script>
</body>
</html>`;

router.get('/admin', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(ADMIN_HTML);
});

module.exports = router;

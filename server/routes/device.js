const router = require('express').Router();
const PrintJob = require('../models/PrintJob');
const authenticateDevice = require('../middleware/deviceAuth');

router.get('/device/download/:jobId', authenticateDevice, async (req, res) => {
  try {
    const job = await PrintJob.findOne({ jobId: req.params.jobId, deviceId: req.device.deviceId });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!['PAID', 'ASSIGNED'].includes(job.status)) {
      return res.status(403).json({ error: 'Job not available for download' });
    }
    if (!job.filePath) {
      return res.status(410).json({ error: 'File no longer available' });
    }
    res.download(job.filePath, job.fileName);
  } catch (err) {
    console.error('Download error:', err.message);
    res.status(500).json({ error: 'Download failed' });
  }
});

module.exports = router;

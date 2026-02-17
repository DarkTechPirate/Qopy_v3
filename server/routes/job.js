const router = require('express').Router();
const PrintJob = require('../models/PrintJob');

const PRICING = { bw: 3, color: 6 };

router.post('/job/options', async (req, res) => {
  try {
    const { jobId, printType, sided, copies } = req.body;
    const job = await PrintJob.findOne({ jobId });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'NOT_PAID') return res.status(400).json({ error: 'Options already set or job already paid' });

    if (!['bw', 'color'].includes(printType)) return res.status(400).json({ error: 'Invalid printType (bw or color)' });
    if (!['single', 'double'].includes(sided)) return res.status(400).json({ error: 'Invalid sided (single or double)' });

    const numCopies = Math.max(1, parseInt(copies) || 1);
    const pricePerSide = PRICING[printType];
    const sheets = sided === 'double' ? Math.ceil(job.pages / 2) : job.pages;
    const totalAmount = sheets * pricePerSide * numCopies;

    job.printType = printType;
    job.sided = sided;
    job.copies = numCopies;
    job.sheets = sheets;
    job.pricePerSide = pricePerSide;
    job.totalAmount = totalAmount;
    await job.save();

    res.json({ success: true, jobId, pages: job.pages, sheets, printType, sided, copies: numCopies, pricePerSide, totalAmount });
  } catch (err) {
    console.error('Options error:', err.message);
    res.status(500).json({ error: 'Failed to set options' });
  }
});

router.get('/job/status/:jobId', async (req, res) => {
  try {
    const job = await PrintJob.findOne({ jobId: req.params.jobId });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({
      jobId: job.jobId, fileName: job.fileName, pages: job.pages,
      sheets: job.sheets, printType: job.printType, sided: job.sided,
      copies: job.copies, totalAmount: job.totalAmount, status: job.status,
      paymentId: job.paymentId, printedPages: job.printedPages || 0,
      printProgress: job.printProgress || null, deviceId: job.deviceId,
      createdAt: job.createdAt, updatedAt: job.updatedAt,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get status' });
  }
});

module.exports = router;

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const PrintJob = require('../models/PrintJob');
const Payment = require('../models/Payment');

// These will be set by app.js after WS handlers are initialized
let sendJobToDevice = null;
let notifyJobUpdate = null;

function setWSHandlers(deviceSender, clientNotifier) {
  sendJobToDevice = deviceSender;
  notifyJobUpdate = clientNotifier;
}

router.get('/payment/qr/:jobId', async (req, res) => {
  try {
    const job = await PrintJob.findOne({ jobId: req.params.jobId });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'NOT_PAID') return res.status(400).json({ error: 'Job not awaiting payment' });
    if (!job.totalAmount) return res.status(400).json({ error: 'Print options not set yet' });

    const upiId = 'qopy@upi';
    const payeeName = 'Qopy Printing';
    const upiLink = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(payeeName)}&am=${job.totalAmount}&cu=INR&tn=Print-${job.jobId.slice(0, 8)}`;

    const qrDataUrl = await QRCode.toDataURL(upiLink, {
      width: 300, margin: 2,
      color: { dark: '#000000', light: '#FFFFFF' }
    });

    res.json({ success: true, jobId: job.jobId, amount: job.totalAmount, qrCode: qrDataUrl, upiLink });
  } catch (err) {
    console.error('QR error:', err.message);
    res.status(500).json({ error: 'QR generation failed' });
  }
});

router.post('/payment/confirm', async (req, res) => {
  try {
    const { jobId } = req.body;
    const job = await PrintJob.findOne({ jobId });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'NOT_PAID') return res.status(400).json({ error: 'Job not awaiting payment' });
    if (!job.totalAmount) return res.status(400).json({ error: 'Print options not set yet' });

    const paymentId = 'PAY_' + uuidv4().slice(0, 12).toUpperCase();

    job.paymentId = paymentId;
    job.status = 'PAID';
    await job.save();

    await Payment.create({
      paymentId,
      jobId: job.jobId,
      amount: job.totalAmount,
      method: 'UPI_SIMULATED',
      status: 'CONFIRMED',
    });

    // Push to printer device via WebSocket
    if (sendJobToDevice) {
      sendJobToDevice(job.deviceId, {
        type: 'NEW_JOB',
        job: {
          jobId: job.jobId, fileName: job.fileName, pages: job.pages,
          sheets: job.sheets, printType: job.printType, sided: job.sided,
          copies: job.copies,
        }
      });
    }

    // Notify frontend clients watching this job
    if (notifyJobUpdate) {
      notifyJobUpdate(job.jobId, {
        status: 'PAID',
        paymentId,
        message: 'Payment confirmed. Your file is queued for printing.'
      });
    }

    res.json({
      success: true, jobId: job.jobId, paymentId,
      status: 'PAID', message: 'Payment confirmed. Your file is queued for printing.'
    });
  } catch (err) {
    console.error('Payment error:', err.message);
    res.status(500).json({ error: 'Payment confirmation failed' });
  }
});

module.exports = router;
module.exports.setWSHandlers = setWSHandlers;

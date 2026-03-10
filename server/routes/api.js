const express = require('express');
const router = express.Router();

const upload = require('../middlewares/upload');
const apiController = require('../controllers/apiController');

// --- 1. UPLOAD PDF ---
router.post('/upload', upload.single('file'), apiController.uploadPdf);

// --- 2. SET OPTIONS AND CALCULATE PRICE ---
router.post('/job/options', apiController.setJobOptions);

// --- 3. GENERATE PAYMENT QR ---
router.get('/payment/qr/:jobId', apiController.getPaymentQr);

// --- 4. CONFIRM PAYMENT (SIMULATED) ---
router.post('/payment/confirm', apiController.confirmPayment);

// --- 5. JOB STATUS CHECK ---
router.get('/job/status/:jobId', apiController.getJobStatus);

module.exports = router;

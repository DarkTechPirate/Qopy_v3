const express = require('express');
const router = express.Router();

const authenticateDevice = require('../middlewares/auth');
const deviceController = require('../controllers/deviceController');

// --- 6. DEVICE POLLS FOR JOBS (only PAID jobs) ---
router.get('/jobs', authenticateDevice, deviceController.getPendingJob);

// --- 7. DEVICE DOWNLOADS FILE (only if PAID) ---
router.get('/download/:jobId', authenticateDevice, deviceController.downloadJobFile);

// --- 8. DEVICE UPDATES JOB STATUS ---
router.post('/job-update', authenticateDevice, deviceController.updateJobStatus);

// --- 8b. DEVICE REPORTS PRINT PROGRESS (page-by-page) ---
router.post('/job-progress', authenticateDevice, deviceController.reportJobProgress);

// --- 9. DEVICE HEARTBEAT ---
router.post('/heartbeat', authenticateDevice, deviceController.updateHeartbeat);

module.exports = router;

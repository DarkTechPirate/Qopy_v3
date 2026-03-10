const fs = require('fs');
const Job = require('../models/Job');

const getPendingJob = async (req, res) => {
    try {
        const pendingJob = await Job.findOne({ deviceId: req.device.deviceId, status: 'PAID' });
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
    } catch (err) {
        res.status(500).json({ error: 'Failed to poll for jobs' });
    }
};

const downloadJobFile = async (req, res) => {
    try {
        const job = await Job.findOne({ jobId: req.params.jobId, deviceId: req.device.deviceId });
        if (!job) return res.status(404).json({ error: 'Job not found' });
        if (!['PAID', 'ASSIGNED', 'PRINTING'].includes(job.status)) return res.status(403).json({ error: 'Job not paid or already processed' });

        // Mark as printing once download starts, unless already marked
        job.status = 'PRINTING';
        await job.save();

        res.download(job.filePath, job.fileName);
    } catch (err) {
        res.status(500).json({ error: 'Failed to download file' });
    }
};

const updateJobStatus = async (req, res) => {
    try {
        const { jobId, status, message } = req.body;
        const job = await Job.findOne({ jobId, deviceId: req.device.deviceId });
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

        if (status === 'COMPLETED') {
            job.completedAt = new Date();
            // Auto-delete the uploaded file after successful print
            if (job.filePath && fs.existsSync(job.filePath)) {
                fs.unlink(job.filePath, (err) => {
                    if (err) console.error('File cleanup failed:', err.message);
                    else console.log(`Cleaned up file for job ${jobId}`);
                });
                job.filePath = null; // Remove file path reference
            }
        }

        await job.save();

        res.json({ success: true, jobId, status });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update job status' });
    }
};

const reportJobProgress = async (req, res) => {
    try {
        const { jobId, printedPages, totalPages, message } = req.body;
        const job = await Job.findOne({ jobId, deviceId: req.device.deviceId });

        if (!job) return res.status(404).json({ error: 'Job not found' });
        if (job.status !== 'PRINTING') return res.status(400).json({ error: 'Job not in PRINTING state' });

        job.printedPages = printedPages || 0;
        job.printProgress = message || `Printing page ${printedPages} of ${totalPages}`;
        await job.save();

        res.json({ success: true, jobId, printedPages, totalPages });
    } catch (err) {
        res.status(500).json({ error: 'Failed to report progress' });
    }
};

const updateHeartbeat = async (req, res) => {
    try {
        req.device.lastSeen = new Date();
        req.device.printerStatus = req.body.printerStatus || 'unknown';
        req.device.paperLevel = req.body.paperLevel || 'unknown';
        req.device.inkLevel = req.body.inkLevel || 'unknown';

        await req.device.save();

        res.json({ success: true, serverTime: new Date().toISOString() });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update heartbeat' });
    }
};

module.exports = {
    getPendingJob,
    downloadJobFile,
    updateJobStatus,
    reportJobProgress,
    updateHeartbeat
};

const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const { PDFDocument } = require('pdf-lib');
const config = require('../config');

// Using MongoDB Models
const Job = require('../models/Job');
const Payment = require('../models/Payment');

const uploadPdf = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const filePath = req.file.path;
        const fileBuffer = fs.readFileSync(filePath);
        const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
        const pageCount = pdfDoc.getPageCount();

        const jobId = uuidv4();

        // Save to MongoDB
        await Job.create({
            jobId,
            fileName: req.file.originalname,
            filePath,
            storedName: req.file.filename,
            pages: pageCount,
            deviceId: 'KIOSK_001', // default device for MVP
            status: 'AWAITING_OPTIONS'
        });

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
};

const setJobOptions = async (req, res) => {
    try {
        const { jobId, printType, sided, copies, orientation, pagesPerSheet } = req.body;
        const job = await Job.findOne({ jobId });

        if (!job) return res.status(404).json({ error: 'Job not found' });
        if (job.status !== 'AWAITING_OPTIONS') return res.status(400).json({ error: 'Options already set' });

        if (!['bw', 'color'].includes(printType)) return res.status(400).json({ error: 'Invalid printType (bw or color)' });
        if (!['single', 'double'].includes(sided)) return res.status(400).json({ error: 'Invalid sided (single or double)' });

        const validOrientation = ['portrait', 'landscape'].includes(orientation) ? orientation : 'portrait';
        const validPagesPerSheet = [1, 2, 4, 6, 9, 16].includes(parseInt(pagesPerSheet)) ? parseInt(pagesPerSheet) : 1;

        const numCopies = Math.max(1, parseInt(copies) || 1);
        const pricePerSide = config.PRICING[printType];

        let logicalPages = Math.ceil(job.pages / validPagesPerSheet);
        let sheets;

        if (sided === 'double') {
            sheets = Math.ceil(logicalPages / 2);
        } else {
            sheets = logicalPages;
        }

        let totalAmount = sheets * pricePerSide * numCopies;

        job.printType = printType;
        job.sided = sided;
        job.orientation = validOrientation;
        job.pagesPerSheet = validPagesPerSheet;
        job.copies = numCopies;
        job.sheets = sheets;
        job.pricePerSide = pricePerSide;
        job.totalAmount = totalAmount;
        job.status = 'AWAITING_PAYMENT';

        await job.save();

        res.json({
            success: true,
            jobId,
            pages: job.pages,
            sheets,
            printType,
            sided,
            orientation: validOrientation,
            pagesPerSheet: validPagesPerSheet,
            copies: numCopies,
            pricePerSide,
            totalAmount
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to set options: ' + err.message });
    }
};

const getPaymentQr = async (req, res) => {
    try {
        const job = await Job.findOne({ jobId: req.params.jobId });
        if (!job) return res.status(404).json({ error: 'Job not found' });
        if (job.status !== 'AWAITING_PAYMENT') return res.status(400).json({ error: 'Job not awaiting payment' });

        const upiId = 'qopy@upi';
        const payeeName = 'Qopy Printing';
        const upiLink = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(payeeName)}&am=${job.totalAmount}&cu=INR&tn=Print-${job.jobId.slice(0, 8)}`;

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
};

const confirmPayment = async (req, res) => {
    try {
        const { jobId } = req.body;
        const job = await Job.findOne({ jobId });
        if (!job) return res.status(404).json({ error: 'Job not found' });
        if (job.status !== 'AWAITING_PAYMENT') return res.status(400).json({ error: 'Job not awaiting payment' });

        const paymentId = 'PAY_' + uuidv4().slice(0, 12).toUpperCase();
        job.paymentId = paymentId;
        job.status = 'PAID';

        await job.save();

        await Payment.create({
            paymentId,
            jobId: job.jobId,
            amount: job.totalAmount,
            method: 'UPI_SIMULATED'
        });

        res.json({
            success: true,
            jobId: job.jobId,
            paymentId,
            status: 'PAID',
            message: 'Payment confirmed. Your file is queued for printing.'
        });
    } catch (err) {
        res.status(500).json({ error: 'Payment confirmation failed: ' + err.message });
    }
};

const getJobStatus = async (req, res) => {
    try {
        const job = await Job.findOne({ jobId: req.params.jobId });
        if (!job) return res.status(404).json({ error: 'Job not found' });

        res.json({
            jobId: job.jobId,
            fileName: job.fileName,
            pages: job.pages,
            sheets: job.sheets,
            printType: job.printType,
            sided: job.sided,
            orientation: job.orientation,
            pagesPerSheet: job.pagesPerSheet,
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
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch status' });
    }
};

module.exports = {
    uploadPdf,
    setJobOptions,
    getPaymentQr,
    confirmPayment,
    getJobStatus
};

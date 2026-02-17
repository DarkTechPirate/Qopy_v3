const router = require('express').Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const PrintJob = require('../models/PrintJob');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  }
});

router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const filePath = req.file.path;
    const fileBuffer = fs.readFileSync(filePath);
    const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
    const pageCount = pdfDoc.getPageCount();
    const jobId = uuidv4();

    await PrintJob.create({
      jobId,
      fileName: req.file.originalname,
      storedName: req.file.filename,
      filePath,
      pages: pageCount,
      deviceId: 'KIOSK_001',
      status: 'NOT_PAID',
    });

    res.json({ success: true, jobId, fileName: req.file.originalname, pages: pageCount });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: 'Failed to process PDF: ' + err.message });
  }
});

module.exports = router;

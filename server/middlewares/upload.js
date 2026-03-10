const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

// --- ENSURE UPLOAD FOLDER ---
if (!fs.existsSync(config.UPLOAD_DIR)) {
    fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
}

// --- MULTER CONFIG ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.UPLOAD_DIR),
    filename: (req, file, cb) => {
        const unique = uuidv4();
        const ext = path.extname(file.originalname);
        cb(null, `${unique}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') cb(null, true);
        else cb(new Error('Only PDF files are allowed'));
    }
});

module.exports = upload;

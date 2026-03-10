const mongoose = require('mongoose');

const JobSchema = new mongoose.Schema({
    jobId: { type: String, required: true, unique: true },
    fileName: { type: String, required: true },
    filePath: { type: String, required: true },
    storedName: { type: String, required: true },
    pages: { type: Number, required: true },
    printType: { type: String, enum: ['bw', 'color', null], default: null },
    sided: { type: String, enum: ['single', 'double', null], default: null },
    orientation: { type: String, enum: ['portrait', 'landscape', null], default: 'portrait' },
    pagesPerSheet: { type: Number, default: 1 },
    copies: { type: Number, default: 1 },
    sheets: { type: Number, default: null },
    pricePerSide: { type: Number, default: null },
    totalAmount: { type: Number, default: null },
    deviceId: { type: String, default: 'KIOSK_001' },
    status: {
        type: String,
        enum: ['AWAITING_OPTIONS', 'AWAITING_PAYMENT', 'PAID', 'PRINTING', 'COMPLETED', 'FAILED'],
        default: 'AWAITING_OPTIONS'
    },
    statusMessage: { type: String, default: null },
    paymentId: { type: String, default: null },
    printedPages: { type: Number, default: 0 },
    printProgress: { type: String, default: null },
    completedAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Job', JobSchema);

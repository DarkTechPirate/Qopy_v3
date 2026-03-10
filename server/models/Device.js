const mongoose = require('mongoose');

const DeviceSchema = new mongoose.Schema({
    deviceId: { type: String, required: true, unique: true },
    apiKey: { type: String, required: true },
    name: { type: String, default: 'Kiosk Printer' },
    location: { type: String, default: 'Default Location' },
    lastSeen: { type: Date, default: null },
    printerStatus: { type: String, default: 'unknown' },
    paperLevel: { type: String, default: 'unknown' },
    inkLevel: { type: String, default: 'unknown' }
}, { timestamps: true });

module.exports = mongoose.model('Device', DeviceSchema);

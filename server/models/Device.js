const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({
  deviceId:      { type: String, required: true, unique: true, index: true },
  apiKey:        { type: String, required: true },
  name:          { type: String, required: true },
  location:      { type: String, default: '' },
  isOnline:      { type: Boolean, default: false },
  lastSeen:      { type: Date, default: null },
  printerStatus: { type: String, default: 'unknown' },
  paperLevel:    { type: String, default: 'unknown' },
  inkLevel:      { type: String, default: 'unknown' },
}, { timestamps: true });

module.exports = mongoose.model('Device', deviceSchema);

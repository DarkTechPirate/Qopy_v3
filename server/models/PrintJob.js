const mongoose = require('mongoose');

const JOB_STATUSES = ['NOT_PAID', 'PAID', 'ASSIGNED', 'PRINTING', 'COMPLETED', 'FAILED'];

const printJobSchema = new mongoose.Schema({
  jobId:          { type: String, required: true, unique: true, index: true },
  deviceId:       { type: String, default: 'KIOSK_001' },
  fileName:       { type: String, required: true },
  storedName:     { type: String, required: true },
  filePath:       { type: String, required: true },
  pages:          { type: Number, required: true },
  printType:      { type: String, enum: ['bw', 'color', null], default: null },
  sided:          { type: String, enum: ['single', 'double', null], default: null },
  copies:         { type: Number, default: 1 },
  sheets:         { type: Number, default: null },
  pricePerSide:   { type: Number, default: null },
  totalAmount:    { type: Number, default: null },
  status:         { type: String, enum: JOB_STATUSES, default: 'NOT_PAID', index: true },
  paymentId:      { type: String, default: null },
  statusMessage:  { type: String, default: null },
  printedPages:   { type: Number, default: 0 },
  printProgress:  { type: String, default: null },
  assignedAt:     { type: Date, default: null },
  completedAt:    { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('PrintJob', printJobSchema);

const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  paymentId:     { type: String, required: true, unique: true, index: true },
  jobId:         { type: String, required: true, index: true },
  amount:        { type: Number, required: true },
  method:        { type: String, default: 'UPI_SIMULATED' },
  status:        { type: String, enum: ['PENDING', 'CONFIRMED', 'REFUNDED'], default: 'CONFIRMED' },
  transactionId: { type: String, default: null },
}, { timestamps: true });

module.exports = mongoose.model('Payment', paymentSchema);

const mongoose = require('mongoose');

const PaymentSchema = new mongoose.Schema({
    paymentId: { type: String, required: true, unique: true },
    jobId: { type: String, required: true },
    amount: { type: Number, required: true },
    method: { type: String, default: 'UPI_SIMULATED' },
    confirmedAt: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('Payment', PaymentSchema);

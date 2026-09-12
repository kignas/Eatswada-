'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
  vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  ledgerEntries: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SettlementLedger' }],
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'INR' },
  status: { type: String, enum: ['pending', 'settled', 'cancelled'], default: 'pending', index: true },
  reference: { type: String, trim: true, maxlength: 120, default: '' },
  settledAt: { type: Date, default: null },
}, { timestamps: true });
module.exports = mongoose.models.SettlementBatch || mongoose.model('SettlementBatch', schema);

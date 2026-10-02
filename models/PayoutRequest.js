'use strict';

const mongoose = require('mongoose');

const payoutRequestSchema = new mongoose.Schema({
  vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
  amount: { type: Number, required: true, min: 1 },
  ledgerEntries: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SettlementLedger' }],
  currency: { type: String, default: 'INR', enum: ['INR'] },
  schedule: { type: String, enum: ['weekly', 'monthly', 'manual'], default: 'weekly' },
  status: { type: String, enum: ['requested', 'processing', 'paid', 'rejected', 'cancelled'], default: 'requested', index: true },
  reference: { type: String, trim: true, maxlength: 120, default: '' },
  adminNote: { type: String, trim: true, maxlength: 500, default: '' },
  requestedAt: { type: Date, default: Date.now },
  processedAt: { type: Date, default: null },
  paidAt: { type: Date, default: null },
}, { timestamps: true });

payoutRequestSchema.index({ vendor: 1, restaurant: 1, status: 1, createdAt: -1 });
payoutRequestSchema.index({ ledgerEntries: 1 });

module.exports = mongoose.models.PayoutRequest || mongoose.model('PayoutRequest', payoutRequestSchema);

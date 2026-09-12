'use strict';
const mongoose = require('mongoose');

const settlementLedgerSchema = new mongoose.Schema({
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
  vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
  orderNumber: { type: String, default: '' },
  foodSales: { type: Number, required: true, min: 0 },
  commissionRate: { type: Number, required: true, min: 0, max: 100 },
  commissionAmount: { type: Number, required: true, min: 0 },
  restaurantNetAmount: { type: Number, required: true, min: 0 },
  adjustmentAmount: { type: Number, default: 0 },
  netSettlementAmount: { type: Number, required: true },
  currency: { type: String, default: 'INR' },
  status: { type: String, enum: ['eligible', 'settled', 'void'], default: 'eligible', index: true },
  settlementBatch: { type: mongoose.Schema.Types.ObjectId, ref: 'SettlementBatch', default: null, index: true },
  eligibleAt: { type: Date, default: Date.now },
  settledAt: { type: Date, default: null },
  source: { type: String, enum: ['order_delivery', 'refund_adjustment'], default: 'order_delivery' },
}, { timestamps: true });
settlementLedgerSchema.index({ order: 1, source: 1 }, { unique: true });
module.exports = mongoose.models.SettlementLedger || mongoose.model('SettlementLedger', settlementLedgerSchema);

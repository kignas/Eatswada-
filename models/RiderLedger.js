'use strict';

// ─────────────────────────────────────────────────────────────────────
// RiderLedger (Pillar 6)
//
// Append-only money ledger for delivery partners. Kept as a separate
// collection from SettlementLedger so rider entries can never leak into
// vendor settlement aggregations. Entry types:
//
//   delivery_earning  +  one per delivered order (frozen earning split)
//   cod_cash_deposit  −  rider hands collected cash back to Admin
//   payout            −  Admin pays out a positive balance (bank/UPI UTR)
//   adjustment        ±  manual credit/debit correction
//
// `riderDetails.cashInHand` on the User stays the authoritative live cash
// balance; this ledger is the auditable history behind it.
// ─────────────────────────────────────────────────────────────────────

const mongoose = require('mongoose');

const riderLedgerSchema = new mongoose.Schema({
  rider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
  orderNumber: { type: String, default: '' },
  entryType: {
    type: String,
    enum: ['delivery_earning', 'cod_cash_deposit', 'payout', 'adjustment'],
    required: true,
    index: true,
  },
  // Signed amount applied to the rider's payable balance. Positive = platform
  // owes the rider; negative = rider owes the platform (e.g. a deposit).
  amount: { type: Number, required: true },
  // Earning split, when entryType === 'delivery_earning'.
  breakdown: {
    basePay: { type: Number, min: 0, default: 0 },
    distancePay: { type: Number, min: 0, default: 0 },
    rainSurgeBonus: { type: Number, min: 0, default: 0 },
    waitTimePay: { type: Number, min: 0, default: 0 },
    tip: { type: Number, min: 0, default: 0 },
  },
  codCashCollected: { type: Number, min: 0, default: 0 },
  // Bank/UPI UTR or reference for deposits and payouts.
  reference: { type: String, default: '', maxlength: 120 },
  // Client-supplied idempotency token for a payout. Unique when present, so a
  // retried payout request can never create a second payout row.
  payoutToken: { type: String, default: null },
  note: { type: String, default: '', maxlength: 300 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  currency: { type: String, default: 'INR' },
}, { timestamps: true });

// One earning entry per delivered order; makes delivery idempotent.
riderLedgerSchema.index({ order: 1, entryType: 1 }, { unique: true, partialFilterExpression: { order: { $type: 'objectId' }, entryType: 'delivery_earning' } });
riderLedgerSchema.index({ rider: 1, createdAt: -1 });
// Idempotency for Admin payouts: one payout row per client-supplied token.
riderLedgerSchema.index({ payoutToken: 1 }, { unique: true, partialFilterExpression: { payoutToken: { $type: 'string' } } });

module.exports = mongoose.models.RiderLedger || mongoose.model('RiderLedger', riderLedgerSchema);

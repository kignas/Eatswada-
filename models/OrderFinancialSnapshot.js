'use strict';

// ─────────────────────────────────────────────────────────────────────
// OrderFinancialSnapshot — the immutable financial record of one order.
//
// A snapshot is written once, at order confirmation, from the authoritative
// quote. After that it is NEVER repriced: a later admin rule change, a new
// rider, or a real gateway fee only ever appends to `actuals`, never rewrites
// `projected`.
//
// The unique index on `order` makes the snapshot idempotent: a retried
// checkout cannot create a second financial record for the same order.
//
// All amounts are integer PAISE (the authoritative unit). Rupee views live in
// the API layer. `pricingRuleVersion` ties the record to the exact rule set
// that produced it.
// ─────────────────────────────────────────────────────────────────────

const mongoose = require('mongoose');

const financialSnapshotSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  orderNumber: { type: String, default: '', index: true },
  checkoutGroupId: { type: String, default: null, index: true },
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', default: null, index: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  rider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

  currency: { type: String, default: 'INR' },
  paymentMethod: { type: String, enum: ['upi', 'card', 'wallet', 'cod'], default: 'upi' },
  isCod: { type: Boolean, default: false },
  isFirstOrder: { type: Boolean, default: false },

  pricingRuleVersion: { type: String, default: '', index: true },
  rules: { type: mongoose.Schema.Types.Mixed, default: {} },

  // ── Route snapshot (provenance of every distance used) ─────────────
  route: {
    restaurantToCustomerKm: { type: Number, default: null },
    riderToRestaurantKm: { type: Number, default: null },
    repositioningKm: { type: Number, default: 0 },
    totalTripKm: { type: Number, default: 0 },
    restaurantToCustomerSec: { type: Number, default: 0 },
    riderToRestaurantSec: { type: Number, default: 0 },
    sources: { type: mongoose.Schema.Types.Mixed, default: {} },
    degraded: { type: Boolean, default: false },
  },

  // ── Projected (frozen at confirmation) ─────────────────────────────
  projected: {
    baseFoodSubtotalPaise: { type: Number, default: 0 },
    customerFoodSubtotalPaise: { type: Number, default: 0 },
    foodPriceUpliftPaise: { type: Number, default: 0 },
    restaurantPayablePaise: { type: Number, default: 0 },
    restaurantFundedDiscountPaise: { type: Number, default: 0 },
    platformFundedDiscountPaise: { type: Number, default: 0 },
    deliveryFeePaise: { type: Number, default: 0 },
    baseDeliveryFeePaise: { type: Number, default: 0 },
    deliverySubsidyPaise: { type: Number, default: 0 },
    smallOrderFeePaise: { type: Number, default: 0 },
    codFeePaise: { type: Number, default: 0 },
    customerTotalPaise: { type: Number, default: 0 },

    riderGuaranteedPayoutPaise: { type: Number, default: 0 },
    riderPickupPaise: { type: Number, default: 0 },
    riderDeliveryPaise: { type: Number, default: 0 },
    riderRepositionPaise: { type: Number, default: 0 },
    riderWaitPaise: { type: Number, default: 0 },
    riderPeakPaise: { type: Number, default: 0 },
    estimatedRiderVehicleExpensesPaise: { type: Number, default: 0 },

    paymentProcessingExpensesPaise: { type: Number, default: 0 },
    applicableTaxesPaise: { type: Number, default: 0 },
    riskAllowancePaise: { type: Number, default: 0 },

    grossRevenuePaise: { type: Number, default: 0 },
    totalCostsPaise: { type: Number, default: 0 },
    expectedContributionPaise: { type: Number, default: 0 },
    minimumRequiredContributionPaise: { type: Number, default: 0 },
  },

  promotionFundingSource: { type: String, default: 'none' },
  decision: {
    type: String,
    enum: ['PROFITABLE', 'REPRICING_REQUIRED', 'NOT_ECONOMICALLY_SERVICEABLE'],
    default: 'PROFITABLE',
  },
  warnings: { type: [String], default: [] },

  quoteIssuedAt: { type: Date, default: null },
  quoteExpiresAt: { type: Date, default: null },

  // ── Actuals (appended after delivery; projected is never rewritten) ─
  actuals: {
    recordedAt: { type: Date, default: null },
    actualRiderPayoutPaise: { type: Number, default: null },
    actualPaymentProcessingExpensesPaise: { type: Number, default: null },
    refundPaise: { type: Number, default: 0 },
    refundRiskRealisedPaise: { type: Number, default: 0 },
    actualRiderVehicleExpensesPaise: { type: Number, default: null },
    actualContributionPaise: { type: Number, default: null },
    notes: { type: String, default: '', maxlength: 500 },
  },

  // Reversal/immutability guard: a snapshot is only ever superseded by an
  // explicit correction entry, never edited in place.
  supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: 'OrderFinancialSnapshot', default: null },
}, { timestamps: true });

financialSnapshotSchema.index({ order: 1 }, { unique: true });
financialSnapshotSchema.index({ restaurant: 1, createdAt: -1 });
financialSnapshotSchema.index({ pricingRuleVersion: 1, createdAt: -1 });

module.exports = mongoose.models.OrderFinancialSnapshot
  || mongoose.model('OrderFinancialSnapshot', financialSnapshotSchema);

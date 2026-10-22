'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, trim: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // ── Pillar 1: maintenance + rider-shortage circuit breaker ──
  isUnderMaintenance: { type: Boolean, default: false },
  maintenanceTitle: { type: String, trim: true, maxlength: 200, default: 'Eatswada is under maintenance' },
  maintenanceMessage: { type: String, trim: true, maxlength: 500, default: 'Ordering is paused for a short scheduled upgrade. Please try again soon.' },
  maintenanceEta: { type: String, trim: true, maxlength: 120, default: '' },
  isDeliveryPausedShortage: { type: Boolean, default: false },
  autoShortageCircuitBreaker: { type: Boolean, default: true },
  maxActiveOrdersPerOnlineRider: { type: Number, min: 1, default: 3 },
  shortageBannerMessage: { type: String, trim: true, maxlength: 300, default: 'All delivery partners are busy right now. Ordering is paused briefly.' },
  isRainSurgeActive: { type: Boolean, default: false },
  rainSurgeFee: { type: Number, min: 0, default: 15 },
  rainExtraEtaMinutes: { type: Number, min: 0, default: 10 },

  // ── Pillar 2: checkout bill + delivery pricing ──
  isGlobalFreeDelivery: { type: Boolean, default: false },
  freeDeliveryMinSubtotal: { type: Number, min: 0, default: 199 },
  isFirstOrderFreeDelivery: { type: Boolean, default: false },
  baseDeliveryFee: { type: Number, min: 0, default: 25 },
  baseDistanceKm: { type: Number, min: 0, default: 2 },
  perKmExtraFee: { type: Number, min: 0, default: 8 },
  platformHandlingFee: { type: Number, min: 0, default: 5 },
  smallCartThreshold: { type: Number, min: 0, default: 99 },
  smallCartFee: { type: Number, min: 0, default: 15 },
  packagingChargePerItem: { type: Number, min: 0, default: 0 },
  taxPercent: { type: Number, min: 0, max: 100, default: 0 },

  // ── Pillar 3: dual payment engine ──
  isUpiEnabled: { type: Boolean, default: true },
  isCodEnabled: { type: Boolean, default: true },
  maxCodOrderAmount: { type: Number, min: 0, default: 1000 },

  // ── Pillar 6: rider pay model ──
  riderBasePay: { type: Number, min: 0, default: 25 },
  riderPerKmPay: { type: Number, min: 0, default: 5 },
  riderWaitTimePayPerMin: { type: Number, min: 0, default: 1 },
  riderRainSurgeBonus: { type: Number, min: 0, default: 15 },
}, { timestamps: true });
module.exports = mongoose.models.PlatformSetting || mongoose.model('PlatformSetting', schema);

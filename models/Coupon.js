'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 40 },
  type: { type: String, enum: ['percent', 'fixed'], required: true },
  value: { type: Number, required: true, min: 0 },
  maxDiscount: { type: Number, default: null, min: 0 },
  minSubtotal: { type: Number, default: 0, min: 0 },
  usageLimit: { type: Number, default: null, min: 1 },
  usedCount: { type: Number, default: 0, min: 0 },
  perUserLimit: { type: Number, default: 1, min: 1 },
  firstOrderOnly: { type: Boolean, default: false },
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', default: null, index: true },
  // Who funds the discount. 'platform' (default) => the restaurant keeps its
  // full commission base and the platform absorbs the discount; 'restaurant'
  // => the restaurant funds the whole discount; 'shared' => the restaurant
  // funds `restaurantSharePercent` of it and the platform funds the rest.
  fundedBy: { type: String, enum: ['platform', 'restaurant', 'shared'], default: 'platform' },
  restaurantSharePercent: { type: Number, min: 0, max: 100, default: 0 },
  startsAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: null },
  isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true });
module.exports = mongoose.models.Coupon || mongoose.model('Coupon', schema);

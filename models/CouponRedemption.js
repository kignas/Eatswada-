'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  coupon: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  orderGroupId: { type: String, required: true },
  discount: { type: Number, required: true, min: 0 },
}, { timestamps: true });
schema.index({ coupon: 1, user: 1 });
schema.index({ orderGroupId: 1 }, { unique: true });
module.exports = mongoose.models.CouponRedemption || mongoose.model('CouponRedemption', schema);

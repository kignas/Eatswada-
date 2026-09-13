'use strict';
const Coupon = require('../models/Coupon');
const CouponRedemption = require('../models/CouponRedemption');
const CouponUsage = require('../models/CouponUsage');

async function claimCouponUsage({ couponId, userId, orderGroupId, discount }) {
  const existing = await CouponRedemption.findOne({ coupon: couponId, orderGroupId }).lean();
  if (existing) return existing;

  const coupon = await Coupon.findById(couponId).select('usageLimit perUserLimit isActive startsAt expiresAt');
  if (!coupon) throw Object.assign(new Error('Coupon is no longer available.'), { statusCode: 409 });

  // Global usage is claimed atomically, so concurrent successful payments cannot
  // push usedCount above usageLimit.
  const global = await Coupon.findOneAndUpdate(
    {
      _id: couponId,
      isActive: true,
      $or: [
        { usageLimit: null },
        { $expr: { $lt: ['$usedCount', '$usageLimit'] } },
      ],
    },
    { $inc: { usedCount: 1 } },
    { new: true }
  ).lean();
  if (!global) throw Object.assign(new Error('Coupon usage limit has been reached.'), { statusCode: 409 });

  const limit = Math.max(1, Number(coupon.perUserLimit || 1));
  let userClaimed = false;
  try {
    const current = await CouponUsage.findOne({ coupon: couponId, user: userId }).lean();
    if (!current) {
      const historical = await CouponRedemption.countDocuments({ coupon: couponId, user: userId });
      if (historical >= limit) throw Object.assign(new Error('You have already used this coupon.'), { statusCode: 409 });
      try {
        await CouponUsage.create({ coupon: couponId, user: userId, usedCount: historical + 1 });
        userClaimed = true;
      } catch (err) {
        if (err?.code !== 11000) throw err;
      }
    }
    if (!userClaimed) {
      const updated = await CouponUsage.findOneAndUpdate(
        { coupon: couponId, user: userId, usedCount: { $lt: limit } },
        { $inc: { usedCount: 1 } },
        { new: true }
      ).lean();
      if (!updated) throw Object.assign(new Error('You have already used this coupon.'), { statusCode: 409 });
      userClaimed = true;
    }

    try {
      return await CouponRedemption.create({
        coupon: couponId,
        user: userId,
        orderGroupId,
        discount: Number(discount || 0),
      });
    } catch (err) {
      if (err?.code === 11000) {
        await CouponUsage.updateOne({ coupon: couponId, user: userId, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
        return CouponRedemption.findOne({ coupon: couponId, orderGroupId });
      }
      throw err;
    }
  } catch (err) {
    if (userClaimed) {
      await CouponUsage.updateOne({ coupon: couponId, user: userId, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } }).catch(() => {});
    }
    await Coupon.updateOne({ _id: couponId, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } }).catch(() => {});
    throw err;
  }
}

module.exports = { claimCouponUsage };

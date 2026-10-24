'use strict';
const Coupon = require('../models/Coupon');
const CouponRedemption = require('../models/CouponRedemption');
const CouponUsage = require('../models/CouponUsage');
const { withRequiredTransaction } = require('./dbTransaction');

/**
 * Claim one coupon redemption atomically across the global counter, per-user
 * counter and order-group redemption record. These are one business operation:
 * compensating `$inc: -1` writes are not sufficient because a process can die
 * before its catch handler runs.
 *
 * MongoDB transaction support is required. If it is unavailable, this rejects
 * rather than leaving partially committed coupon counters. The caller can retry
 * the same payment/webhook; the order/payment claim remains idempotent.
 */
async function claimCouponUsage({ couponId, userId, orderGroupId, discount }) {
  const args = { couponId, userId, orderGroupId, discount: Number(discount || 0) };
  let duplicateKeyRetry = 0;

  while (true) {
    try {
      return await withRequiredTransaction(async (session) => {
        const existing = await CouponRedemption.findOne({ coupon: args.couponId, orderGroupId: args.orderGroupId })
          .session(session)
          .lean();
        if (existing) return existing;

        const coupon = await Coupon.findById(args.couponId)
          .select('usageLimit perUserLimit isActive startsAt expiresAt')
          .session(session);
        if (!coupon) throw Object.assign(new Error('Coupon is no longer available.'), { statusCode: 409 });

        // Global limit claim is atomic and part of the same transaction as the
        // per-user claim and redemption insertion.
        const global = await Coupon.findOneAndUpdate(
          {
            _id: args.couponId,
            isActive: true,
            $or: [
              { usageLimit: null },
              { $expr: { $lt: ['$usedCount', '$usageLimit'] } },
            ],
          },
          { $inc: { usedCount: 1 } },
          { new: true, session },
        ).lean();
        if (!global) throw Object.assign(new Error('Coupon usage limit has been reached.'), { statusCode: 409 });

        const limit = Math.max(1, Number(coupon.perUserLimit || 1));
        const current = await CouponUsage.findOne({ coupon: args.couponId, user: args.userId })
          .session(session)
          .lean();

        if (!current) {
          const historical = await CouponRedemption.countDocuments({ coupon: args.couponId, user: args.userId })
            .session(session);
          if (historical >= limit) throw Object.assign(new Error('You have already used this coupon.'), { statusCode: 409 });
          // Unique (coupon,user) protects concurrent first-use insertion. If a
          // competing transaction wins, retry outside after its transaction is
          // committed so this transaction can enforce the current per-user limit.
          await CouponUsage.create([{
            coupon: args.couponId,
            user: args.userId,
            usedCount: historical + 1,
          }], { session });
        } else {
          const updated = await CouponUsage.findOneAndUpdate(
            { coupon: args.couponId, user: args.userId, usedCount: { $lt: limit } },
            { $inc: { usedCount: 1 } },
            { new: true, session },
          ).lean();
          if (!updated) throw Object.assign(new Error('You have already used this coupon.'), { statusCode: 409 });
        }

        const created = await CouponRedemption.create([{
          coupon: args.couponId,
          user: args.userId,
          orderGroupId: args.orderGroupId,
          discount: args.discount,
        }], { session });
        return created[0];
      });
    } catch (err) {
      if (err?.code !== 11000 || duplicateKeyRetry >= 1) throw err;
      // A duplicate may be the same orderGroup redemption (idempotent replay),
      // or a concurrent first-use CouponUsage insert. The transaction was
      // aborted, so no counters from the failed attempt remain committed.
      const existing = await CouponRedemption.findOne({ coupon: args.couponId, orderGroupId: args.orderGroupId }).lean();
      if (existing) return existing;
      duplicateKeyRetry += 1;
    }
  }
}

module.exports = { claimCouponUsage };

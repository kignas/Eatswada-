'use strict';
const asyncHandler = require('express-async-handler');
const Coupon = require('../models/Coupon');
const Redemption = require('../models/CouponRedemption');
const Order = require('../models/Order');

// Admin input limits (guards against typos like 10000% or a 10-lakh flat discount).
const MAX_FIXED_VALUE = 5000;       // ₹ for a fixed coupon and for maxDiscount
const MAX_MIN_SUBTOTAL = 100000;    // ₹
const MAX_USAGE_LIMIT = 1000000;
const MAX_PER_USER_LIMIT = 100;
const FUNDED_BY = ['platform', 'restaurant', 'shared'];

function admin(req, res) {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ success: false, message: 'Admin credentials required.' });
    return false;
  }
  return true;
}
function normalize(code) { return String(code || '').trim().toUpperCase(); }

const isObjectId = (v) => typeof v === 'string' && /^[a-f\d]{24}$/i.test(v);
const isBlank = (v) => v === undefined || v === null || v === '';
// Numbers or numeric strings only (form inputs send strings); anything else -> NaN.
const toNum = (v) => ((typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) ? Number(v) : NaN);
// true / false / 'true' / 'false' only; anything else -> undefined.
const toBool = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined);
const toDate = (v) => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Builds the ONLY document create() may store. Unknown fields (usedCount, _id, timestamps...) are ignored.
function buildCouponInput(b) {
  const bad = (message) => ({ error: message });
  const data = {};

  const code = normalize(b.code);
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) return bad('Invalid coupon code.');
  data.code = code;

  if (b.type !== 'percent' && b.type !== 'fixed') return bad('Coupon type must be "percent" or "fixed".');
  data.type = b.type;

  const value = toNum(b.value);
  if (!Number.isFinite(value)) return bad('Coupon value must be a number.');
  if (b.type === 'percent' && (value < 1 || value > 100)) return bad('Percent coupons must be between 1 and 100.');
  if (b.type === 'fixed' && (value <= 0 || value > MAX_FIXED_VALUE)) return bad(`Fixed coupons must be above 0 and at most ₹${MAX_FIXED_VALUE}.`);
  data.value = value;

  if (!isBlank(b.maxDiscount)) {
    const n = toNum(b.maxDiscount);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_FIXED_VALUE) return bad(`Max discount must be above 0 and at most ₹${MAX_FIXED_VALUE}.`);
    data.maxDiscount = n;
  }
  if (!isBlank(b.minSubtotal)) {
    const n = toNum(b.minSubtotal);
    if (!Number.isFinite(n) || n < 0 || n > MAX_MIN_SUBTOTAL) return bad(`Minimum subtotal must be between 0 and ₹${MAX_MIN_SUBTOTAL}.`);
    data.minSubtotal = n;
  }
  if (!isBlank(b.usageLimit)) {
    const n = toNum(b.usageLimit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_USAGE_LIMIT) return bad(`Usage limit must be a whole number from 1 to ${MAX_USAGE_LIMIT}.`);
    data.usageLimit = n;
  }
  if (!isBlank(b.perUserLimit)) {
    const n = toNum(b.perUserLimit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PER_USER_LIMIT) return bad(`Per-user limit must be a whole number from 1 to ${MAX_PER_USER_LIMIT}.`);
    data.perUserLimit = n;
  }
  for (const key of ['firstOrderOnly', 'isActive']) {
    if (!isBlank(b[key])) {
      const flag = toBool(b[key]);
      if (flag === undefined) return bad(`${key} must be true or false.`);
      data[key] = flag;
    }
  }
  if (!isBlank(b.restaurant)) {
    if (!isObjectId(b.restaurant)) return bad('Invalid restaurant id.');
    data.restaurant = b.restaurant;
  }
  if (!isBlank(b.fundedBy)) {
    if (!FUNDED_BY.includes(b.fundedBy)) return bad('fundedBy must be platform, restaurant or shared.');
    data.fundedBy = b.fundedBy;
  }
  if (!isBlank(b.restaurantSharePercent)) {
    const n = toNum(b.restaurantSharePercent);
    if (!Number.isFinite(n) || n < 0 || n > 100) return bad('Restaurant share must be between 0 and 100.');
    data.restaurantSharePercent = n;
  }

  let startsAt = null;
  if (!isBlank(b.startsAt)) {
    startsAt = toDate(b.startsAt);
    if (!startsAt) return bad('Invalid start date.');
    data.startsAt = startsAt;
  }
  if (!isBlank(b.expiresAt)) {
    const expiresAt = toDate(b.expiresAt);
    if (!expiresAt) return bad('Invalid expiry date.');
    if (expiresAt <= (startsAt || new Date())) return bad('Expiry date must be after the start date.');
    data.expiresAt = expiresAt;
  }
  return { data };
}

async function validateCoupon(code, userId, subtotal, restaurantId) {
  const c = await Coupon.findOne({ code: normalize(code), isActive: true, startsAt: { $lte: new Date() }, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] });
  if (!c) return { ok: false, message: 'Coupon is invalid or expired.' };
  if (Number(subtotal) < Number(c.minSubtotal || 0)) return { ok: false, message: `Minimum subtotal for this coupon is ₹${c.minSubtotal}.` };
  if (c.restaurant && String(c.restaurant) !== String(restaurantId)) return { ok: false, message: 'Coupon is not valid for this restaurant.' };
  if (c.usageLimit != null && c.usedCount >= c.usageLimit) return { ok: false, message: 'Coupon usage limit has been reached.' };
  const used = await Redemption.countDocuments({ coupon: c._id, user: userId });
  if (used >= Number(c.perUserLimit || 1)) return { ok: false, message: 'You have already used this coupon.' };
  if (c.firstOrderOnly && await Order.exists({ user: userId, status: 'delivered' })) return { ok: false, message: 'This coupon is for first orders only.' };
  let discount = c.type === 'percent' ? Number(subtotal) * Number(c.value) / 100 : Number(c.value);
  if (c.maxDiscount != null) discount = Math.min(discount, Number(c.maxDiscount));
  discount = Math.max(0, Math.min(discount, Number(subtotal)));
  return { ok: true, coupon: c, discount: Math.round(discount * 100) / 100 };
}

exports.validate = asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ success: false, message: 'Authentication required.' });
  const out = await validateCoupon(req.body?.code, req.user._id, Number(req.body?.subtotal) || 0, req.body?.restaurantId);
  if (!out.ok) return res.status(400).json({ success: false, message: out.message });
  res.json({ success: true, data: { code: out.coupon.code, discount: out.discount, type: out.coupon.type } });
});

exports.create = asyncHandler(async (req, res) => {
  if (!admin(req, res)) return;
  const { data, error } = buildCouponInput(req.body || {});
  if (error) return res.status(400).json({ success: false, code: 'INVALID_COUPON', message: error });
  let coupon;
  try {
    coupon = await Coupon.create(data);
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ success: false, code: 'COUPON_CODE_EXISTS', message: 'A coupon with this code already exists.' });
    throw err;
  }
  res.status(201).json({ success: true, data: coupon });
});

exports.list = asyncHandler(async (req, res) => {
  if (!admin(req, res)) return;
  res.json({ success: true, data: await Coupon.find().sort({ createdAt: -1 }).lean() });
});

exports.toggle = asyncHandler(async (req, res) => {
  if (!admin(req, res)) return;
  if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, code: 'INVALID_COUPON_ID', message: 'Invalid coupon id.' });
  const isActive = toBool(req.body?.isActive);
  if (isActive === undefined) return res.status(400).json({ success: false, code: 'INVALID_COUPON', message: 'isActive must be true or false.' });
  const c = await Coupon.findByIdAndUpdate(req.params.id, { $set: { isActive } }, { new: true });
  if (!c) return res.status(404).json({ success: false, message: 'Coupon not found.' });
  res.json({ success: true, data: c });
});

exports.validateCoupon = validateCoupon;

/**
 * paymentService.js
 * Integrates Razorpay for UPI / card payments.
 * Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env to activate.
 */

let Razorpay;
try { Razorpay = require('razorpay'); } catch (_) { /* optional dep */ }

const crypto = require('crypto');

const getRazorpay = () => {
  if (!Razorpay) throw new Error('razorpay package not installed. Run: npm install razorpay');
  return new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
};

/**
 * Create a Razorpay order
 * @param {number} amount  - amount in paise (₹1 = 100 paise)
 * @param {string} receipt - usually the MongoDB order _id
 */
const createRazorpayOrder = async (amount, receipt) => {
  const instance = getRazorpay();
  const order = await instance.orders.create({
    amount:   Math.round(amount * 100),
    currency: 'INR',
    receipt:  receipt.toString(),
  });
  return order;
};

/**
 * Verify Razorpay payment signature (call after payment on frontend)
 */
const verifyRazorpaySignature = (razorpayOrderId, razorpayPaymentId, razorpaySignature) => {
  const body      = razorpayOrderId + '|' + razorpayPaymentId;
  const expected  = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');
  return expected === razorpaySignature;
};

module.exports = { createRazorpayOrder, verifyRazorpaySignature };

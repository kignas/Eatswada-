/**
 * Production Razorpay integration helpers.
 * Secrets stay server-side. Never expose RAZORPAY_KEY_SECRET to the browser.
 */
const crypto = require('crypto');

let Razorpay;
try { Razorpay = require('razorpay'); } catch (_) { Razorpay = null; }

function assertConfigured() {
  if (!Razorpay) {
    const err = new Error('Razorpay SDK is not installed. Run npm install.');
    err.statusCode = 503;
    throw err;
  }
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    const err = new Error('Razorpay is not configured on the server.');
    err.statusCode = 503;
    throw err;
  }
}

function getRazorpay() {
  assertConfigured();
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

function toPaise(amountRupees) {
  const n = Number(amountRupees);
  if (!Number.isFinite(n) || n <= 0) {
    const err = new Error('Payment amount must be greater than zero.');
    err.statusCode = 400;
    throw err;
  }
  return Math.round(n * 100);
}

async function createRazorpayOrder(amountRupees, receipt, notes = {}) {
  const instance = getRazorpay();
  const amount = toPaise(amountRupees);
  return instance.orders.create({
    amount,
    currency: 'INR',
    receipt: String(receipt).slice(0, 40),
    notes,
  });
}

async function fetchPayment(paymentId) {
  const instance = getRazorpay();
  return instance.payments.fetch(String(paymentId));
}

function verifyRazorpaySignature(razorpayOrderId, razorpayPaymentId, razorpaySignature) {
  if (!process.env.RAZORPAY_KEY_SECRET) return false;
  const body = `${razorpayOrderId}|${razorpayPaymentId}`;
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(razorpaySignature || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyWebhookSignature(rawBody, signature) {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) return false;
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  assertConfigured,
  createRazorpayOrder,
  fetchPayment,
  verifyRazorpaySignature,
  verifyWebhookSignature,
  toPaise,
};

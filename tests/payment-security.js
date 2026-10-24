const assert = require('assert');
const crypto = require('crypto');
process.env.RAZORPAY_KEY_SECRET = 'unit-test-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'webhook-secret';
const { verifyRazorpaySignature, verifyWebhookSignature, toPaise } = require('../services/paymentService');

const rpOrder = 'order_TEST123';
const payment = 'pay_TEST123';
const sig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${rpOrder}|${payment}`).digest('hex');
assert.strictEqual(verifyRazorpaySignature(rpOrder, payment, sig), true);
assert.strictEqual(verifyRazorpaySignature(rpOrder, payment, sig.slice(0, -1) + '0'), false);

const body = Buffer.from(JSON.stringify({ event: 'payment.captured' }));
const wh = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
assert.strictEqual(verifyWebhookSignature(body, wh), true);
assert.strictEqual(verifyWebhookSignature(body, 'bad'), false);
assert.strictEqual(toPaise(12.34), 1234);
assert.throws(() => toPaise(0), /finite positive/);
assert.throws(() => toPaise(-1), /finite positive/);
assert.throws(() => toPaise(0.001), /at least one paisa/);
assert.throws(() => toPaise(Number.POSITIVE_INFINITY), /finite positive/);
console.log('payment-security: PASS');

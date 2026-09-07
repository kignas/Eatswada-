const asyncHandler = require('express-async-handler');
const Order = require('../models/Order');
const Cart = require('../models/Cart');
const {
  createRazorpayOrder,
  fetchPayment,
  verifyRazorpaySignature,
  verifyWebhookSignature,
  assertConfigured,
  toPaise,
} = require('../services/paymentService');

function publicPayment(order) {
  return {
    provider: 'razorpay',
    keyId: process.env.RAZORPAY_KEY_ID || '',
    orderId: order.razorpayOrderId || '',
    amount: toPaise(order.total),
    currency: 'INR',
    paymentStatus: order.paymentStatus,
  };
}

async function findCheckoutOrders(userId, primaryOrderId) {
  const primary = await Order.findOne({ _id: primaryOrderId, user: userId });
  if (!primary) return null;
  if (primary.paymentMethod === 'cod') return [primary];
  if (!primary.razorpayOrderId) return [primary];
  return Order.find({ user: userId, razorpayOrderId: primary.razorpayOrderId }).sort({ createdAt: 1 });
}

async function markCheckoutPaid(orders, paymentId) {
  const ids = orders.map(o => o._id);
  await Order.updateMany(
    { _id: { $in: ids } },
    { $set: { paymentStatus: 'paid', razorpayPaymentId: String(paymentId) } }
  );
  await Cart.findOneAndUpdate(
    { user: orders[0].user },
    { $set: { items: [], restaurant: null, restaurantName: '', subtotal: 0, deliveryFee: 0, total: 0, paymentMethod: 'cod' } }
  );
}

exports.verifyPayment = asyncHandler(async (req, res) => {
  assertConfigured();
  const { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature } = req.body || {};
  if (!orderId || !razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
    return res.status(400).json({ success: false, message: 'Payment verification fields are required.' });
  }

  const orders = await findCheckoutOrders(req.user._id, orderId);
  if (!orders || !orders.length) return res.status(404).json({ success: false, message: 'Order not found.' });
  if (orders[0].paymentMethod === 'cod') return res.status(400).json({ success: false, message: 'This order does not use online payment.' });

  const storedRazorpayOrderId = orders[0].razorpayOrderId;
  if (!storedRazorpayOrderId || storedRazorpayOrderId !== String(razorpayOrderId)) {
    return res.status(400).json({ success: false, message: 'Razorpay order mismatch.' });
  }

  if (orders.every(o => o.paymentStatus === 'paid' && o.razorpayPaymentId === String(razorpayPaymentId))) {
    return res.json({ success: true, alreadyPaid: true, paymentStatus: 'paid', orderIds: orders.map(o => o._id) });
  }

  if (!verifyRazorpaySignature(storedRazorpayOrderId, razorpayPaymentId, razorpaySignature)) {
    return res.status(400).json({ success: false, message: 'Invalid payment signature.' });
  }

  const payment = await fetchPayment(razorpayPaymentId);
  const expectedAmount = Math.round(orders.reduce((sum, o) => sum + Number(o.total || 0), 0) * 100);
  if (String(payment.order_id || '') !== storedRazorpayOrderId) {
    return res.status(400).json({ success: false, message: 'Payment belongs to a different Razorpay order.' });
  }
  if (Number(payment.amount) !== expectedAmount || String(payment.currency || '') !== 'INR') {
    return res.status(400).json({ success: false, message: 'Payment amount or currency does not match the server total.' });
  }
  if (payment.status !== 'captured') {
    return res.status(409).json({ success: false, message: `Payment is ${payment.status || 'not captured yet'}.`, paymentStatus: payment.status || 'pending' });
  }

  await markCheckoutPaid(orders, razorpayPaymentId);
  return res.json({ success: true, paymentStatus: 'paid', orderIds: orders.map(o => o._id), razorpayPaymentId });
});

exports.retryPayment = asyncHandler(async (req, res) => {
  assertConfigured();
  const { orderId } = req.body || {};
  if (!orderId) return res.status(400).json({ success: false, message: 'orderId is required.' });

  const orders = await findCheckoutOrders(req.user._id, orderId);
  if (!orders || !orders.length) return res.status(404).json({ success: false, message: 'Order not found.' });
  if (orders[0].paymentMethod === 'cod') return res.status(400).json({ success: false, message: 'COD orders do not need online payment.' });
  if (orders.some(o => o.paymentStatus === 'paid')) return res.status(409).json({ success: false, message: 'This checkout is already paid.' });

  const amount = orders.reduce((sum, o) => sum + Number(o.total || 0), 0);
  const rpOrder = await createRazorpayOrder(amount, orders[0].orderNumber || orders[0]._id, {
    userId: String(req.user._id),
    orderIds: orders.map(o => String(o._id)).join(',').slice(0, 240),
  });
  await Order.updateMany({ _id: { $in: orders.map(o => o._id) } }, { $set: { razorpayOrderId: rpOrder.id, paymentStatus: 'pending', razorpayPaymentId: '' } });

  return res.json({
    success: true,
    payment: { provider: 'razorpay', keyId: process.env.RAZORPAY_KEY_ID, orderId: rpOrder.id, amount: rpOrder.amount, currency: rpOrder.currency },
  });
});

exports.paymentStatus = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, user: req.user._id }).select('paymentMethod paymentStatus razorpayOrderId razorpayPaymentId total');
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  res.json({ success: true, data: { ...publicPayment(order), orderId: order._id, paymentId: order.razorpayPaymentId || null } });
});

exports.handleWebhook = asyncHandler(async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  const signature = req.get('x-razorpay-signature');
  if (!verifyWebhookSignature(rawBody, signature)) {
    return res.status(400).json({ success: false, message: 'Invalid webhook signature.' });
  }

  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); }
  catch (_) { return res.status(400).json({ success: false, message: 'Invalid webhook payload.' }); }

  const paymentEntity = event?.payload?.payment?.entity;
  if (!paymentEntity) return res.json({ success: true, ignored: true });

  const razorpayOrderId = String(paymentEntity.order_id || '');
  const paymentId = String(paymentEntity.id || '');
  if (!razorpayOrderId || !paymentId) return res.json({ success: true, ignored: true });

  const orders = await Order.find({ razorpayOrderId });
  if (!orders.length) return res.json({ success: true, ignored: true });

  const expectedAmount = Math.round(orders.reduce((sum, o) => sum + Number(o.total || 0), 0) * 100);
  const actualAmount = Number(paymentEntity.amount || 0);
  if (actualAmount !== expectedAmount || String(paymentEntity.currency || '') !== 'INR') {
    return res.status(400).json({ success: false, message: 'Webhook amount/currency mismatch.' });
  }

  if (event.event === 'payment.captured' || paymentEntity.status === 'captured') {
    await markCheckoutPaid(orders, paymentId);
  } else if (event.event === 'payment.failed') {
    await Order.updateMany({ _id: { $in: orders.map(o => o._id) }, paymentStatus: { $ne: 'paid' } }, { $set: { paymentStatus: 'failed', razorpayPaymentId: paymentId } });
  }

  return res.json({ success: true });
});

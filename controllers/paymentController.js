const asyncHandler = require('express-async-handler');
const Order = require('../models/Order');
const { applyRefundAdjustment } = require('../services/settlementService');
const Cart = require('../models/Cart');
const Coupon = require('../models/Coupon');
const { claimCouponUsage } = require('../services/couponUsageService');
const pushService = require('../services/pushService');
const { initiateOrderRefund, refundDuplicatePayment } = require('../services/refundService');
const {
  createRazorpayOrder,
  fetchPayment,
  fetchOrderPayments,
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

// Every order that belongs to a Razorpay order id — whether it is the order's
// CURRENT id or an OLD one kept in razorpayOrderIdHistory after a retry.
function ordersForRazorpayOrder(razorpayOrderId, userId) {
  const id = String(razorpayOrderId || '');
  if (!id) return Promise.resolve([]);
  const filter = { $or: [{ razorpayOrderId: id }, { razorpayOrderIdHistory: id }] };
  if (userId) filter.user = userId;
  return Order.find(filter).sort({ createdAt: 1 });
}

async function findCheckoutOrders(userId, primaryOrderId, razorpayOrderId) {
  const primary = await Order.findOne({ _id: primaryOrderId, user: userId });
  if (!primary) return null;
  if (primary.paymentMethod === 'cod') return [primary];
  // The client may be completing an OLDER Razorpay order of this checkout
  // (e.g. a UPI payment that finished after a retry was started).
  const known = [primary.razorpayOrderId, ...(primary.razorpayOrderIdHistory || [])].filter(Boolean);
  const target = razorpayOrderId && known.includes(String(razorpayOrderId))
    ? String(razorpayOrderId)
    : primary.razorpayOrderId;
  if (!target) return [primary];
  return ordersForRazorpayOrder(target, userId);
}

const isSettledPayment = (o) => ['paid', 'refunded'].includes(o.paymentStatus);

/**
 * Record a captured payment against its checkout.
 *
 * Launch-fixes:
 *  - Orders the customer CANCELLED before the money arrived are no longer
 *    turned into live paid orders. They are marked paid (so the money is
 *    traceable) and immediately refunded; the vendor is never notified.
 *  - If this checkout was already paid by a DIFFERENT payment (old + new
 *    Razorpay order both paid after a retry), this payment is refunded in full
 *    instead of being silently absorbed.
 *
 * Returns { liveOrderIds, refundedOrderIds, duplicate }.
 */
async function markCheckoutPaid(orders, paymentId, amountPaise) {
  const pid = String(paymentId);
  const ids = orders.map(o => o._id);

  // Fast path for a payment that already lost to a previously settled payment.
  // The atomic claim below is still required because two different captures can
  // arrive at exactly the same time and both can initially read the checkout as
  // unpaid.
  const paidByOther = orders.some(o => isSettledPayment(o) && o.razorpayPaymentId && o.razorpayPaymentId !== pid);
  if (paidByOther) {
    await refundDuplicatePayment(ids, pid, Number(amountPaise || 0) / 100);
    return { liveOrderIds: [], refundedOrderIds: [], duplicate: true };
  }

  const liveOrders = orders.filter(o => o.status !== 'cancelled');
  const liveUnpaid = liveOrders.filter(o => !isSettledPayment(o));
  // Idempotent webhook/verify retry: if every live child is already settled by
  // this exact payment, there is nothing left to claim and no refund is due.
  if (liveOrders.length && liveUnpaid.length === 0 && liveOrders.every(o => o.razorpayPaymentId === pid)) {
    return { liveOrderIds: liveOrders.map(o => o._id), refundedOrderIds: [], duplicate: false };
  }

  // Atomically elect exactly one captured payment as the owner of this checkout.
  // This closes the webhook/verify race where payment A and payment B both read
  // an unpaid checkout before either request writes paymentStatus='paid'.
  // A retry of the SAME payment id is allowed to continue an interrupted claim.
  const liveLeader = liveUnpaid[0] || liveOrders[0];
  if (!liveLeader) return { liveOrderIds: [], refundedOrderIds: [], duplicate: false };
  const claim = await Order.findOneAndUpdate(
    {
      _id: liveLeader._id,
      paymentStatus: { $nin: ['paid', 'refunded'] },
      $or: [
        { paymentClaimId: { $exists: false } },
        { paymentClaimId: null },
        { paymentClaimId: '' },
      ],
    },
    { $set: { paymentClaimId: pid } },
    { new: true }
  );

  // Only the request that actually elects a fresh payment claim should emit
  // vendor/admin notifications. A same-payment retry may still finish a
  // partially committed checkout, but must not ring the vendor twice.
  let shouldNotify = !!claim;

  if (!claim) {
    // IMPORTANT: a webhook and /payments/verify can race for the SAME captured
    // payment. If the other request already claimed this exact payment id, it
    // is NOT a duplicate payment and must never be refunded. The old code
    // treated every failed claim as a duplicate, which could refund the real
    // checkout while leaving the customer order in `placed` and hiding it from
    // the vendor queue.
    const currentLeader = await Order.findById(liveLeader._id).select('paymentClaimId paymentStatus razorpayPaymentId');
    if (currentLeader && String(currentLeader.paymentClaimId || '') !== pid) {
      await refundDuplicatePayment(ids, pid, Number(amountPaise || 0) / 100);
      return { liveOrderIds: [], refundedOrderIds: [], duplicate: true };
    }
    // Same payment id already owns the claim. Continue idempotently and let
    // this request finish the shared checkout state if the original claimant
    // was interrupted. It does not become the notification owner.
    shouldNotify = false;
  }

  const unpaid = { $nin: ['paid', 'refunded'] };
  await Order.updateMany(
    { _id: { $in: ids }, paymentStatus: unpaid, status: { $ne: 'cancelled' } },
    { $set: { paymentStatus: 'paid', razorpayPaymentId: pid } }
  );
  // Cancelled before payment captured: record the money against the order so
  // the refund service can return it.
  await Order.updateMany(
    { _id: { $in: ids }, paymentStatus: unpaid, status: 'cancelled' },
    { $set: { paymentStatus: 'paid', razorpayPaymentId: pid } }
  );

  const fresh = await Order.find({ _id: { $in: ids } }).sort({ createdAt: 1 });
  const ours = fresh.filter(o => o.razorpayPaymentId === pid);
  const live = ours.filter(o => o.status !== 'cancelled' && o.paymentStatus === 'paid');
  const cancelled = ours.filter(o => o.status === 'cancelled');

  for (const o of cancelled) {
    await initiateOrderRefund(o, 'Payment received after the order was cancelled');
  }

  if (live.length) {
    const couponIds = [...new Set(live.map(o => o.coupon?.couponId).filter(Boolean).map(String))];
    if (couponIds.length) {
      const groupId = String(live[0].checkoutGroupId || live[0]._id);
      for (const couponId of couponIds) {
        const discount = live
          .filter(o => String(o.coupon?.couponId) === couponId)
          .reduce((a, o) => a + Number(o.coupon?.discount || 0), 0);
        await claimCouponUsage({
          couponId,
          userId: live[0].user,
          orderGroupId: groupId,
          discount,
        });
      }
    }
    await Cart.findOneAndUpdate(
      { user: live[0].user },
      { $set: { items: [], restaurant: null, restaurantName: '', subtotal: 0, deliveryFee: 0, total: 0, paymentMethod: 'upi' } }
    );

    // Order is now paid → visible to the vendor. Ring their device(s) until they act.
    // If this is a concurrent retry of the SAME payment after another request
    // already committed the checkout, do not ring the restaurant a second time.
    if (shouldNotify) {
      for (const o of live) {
        // Vendor + admin notifications are emitted only after payment is verified.
        // Both functions are idempotent and never block a successful checkout.
        pushService.notifyRestaurantNewOrder(o).catch((err) => console.error('[PUSH] vendor new-order:', err.message));
        pushService.notifyAdminsNewOrder(o).catch((err) => console.error('[PUSH] admin-new-order:', err.message));
      }
    }
  }

  return {
    liveOrderIds: live.map(o => o._id),
    refundedOrderIds: cancelled.map(o => o._id),
    duplicate: false,
  };
}

exports.verifyPayment = asyncHandler(async (req, res) => {
  assertConfigured();
  const { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature } = req.body || {};
  if (!orderId || !razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
    return res.status(400).json({ success: false, message: 'Payment verification fields are required.' });
  }

  const orders = await findCheckoutOrders(req.user._id, orderId, razorpayOrderId);
  if (!orders || !orders.length) return res.status(404).json({ success: false, message: 'Order not found.' });
  if (orders[0].paymentMethod === 'cod') return res.status(400).json({ success: false, message: 'This order does not use online payment.' });

  const knownIds = new Set(orders.flatMap(o => [o.razorpayOrderId, ...(o.razorpayOrderIdHistory || [])]).filter(Boolean));
  if (!knownIds.has(String(razorpayOrderId))) {
    return res.status(400).json({ success: false, message: 'Razorpay order mismatch.' });
  }
  const storedRazorpayOrderId = String(razorpayOrderId);

  const liveOrders = orders.filter(o => o.status !== 'cancelled');
  if (liveOrders.length && liveOrders.every(o => o.paymentStatus === 'paid' && o.razorpayPaymentId === String(razorpayPaymentId))) {
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

  const result = await markCheckoutPaid(orders, razorpayPaymentId, payment.amount);
  if (result.duplicate) {
    return res.json({
      success: true,
      alreadyPaid: true,
      duplicatePaymentRefunded: true,
      paymentStatus: 'paid',
      orderIds: orders.map(o => o._id),
      message: 'This order was already paid. The extra payment is being refunded to you.',
    });
  }
  return res.json({
    success: true,
    paymentStatus: 'paid',
    orderIds: orders.map(o => o._id),
    razorpayPaymentId,
    ...(result.refundedOrderIds.length ? {
      refundedOrderIds: result.refundedOrderIds,
      message: 'Some items were cancelled before payment. That amount is being refunded.',
    } : {}),
  });
});

exports.retryPayment = asyncHandler(async (req, res) => {
  assertConfigured();
  const { orderId } = req.body || {};
  if (!orderId) return res.status(400).json({ success: false, message: 'orderId is required.' });

  const orders = await findCheckoutOrders(req.user._id, orderId);
  if (!orders || !orders.length) return res.status(404).json({ success: false, message: 'Order not found.' });
  if (orders[0].paymentMethod === 'cod') return res.status(400).json({ success: false, message: 'COD orders do not need online payment.' });
  if (orders.some(o => isSettledPayment(o))) return res.status(409).json({ success: false, message: 'This checkout is already paid.' });

  // Cancelled orders are not charged again.
  const live = orders.filter(o => o.status !== 'cancelled');
  if (!live.length) return res.status(409).json({ success: false, message: 'This order has been cancelled.' });

  // Launch-fix: before opening a NEW Razorpay order, check whether the current
  // one was actually paid (UPI can confirm late). If so, record that payment
  // instead of asking the customer to pay twice.
  const previousRazorpayOrderId = live[0].razorpayOrderId || '';
  if (previousRazorpayOrderId) {
    let captured = null;
    try {
      const attempts = await fetchOrderPayments(previousRazorpayOrderId);
      captured = attempts.find(p => p.status === 'captured') || null;
    } catch (err) {
      console.warn(`[PAYMENT] retry pre-check failed for ${previousRazorpayOrderId}: ${err.message}`);
    }
    if (captured) {
      const all = await ordersForRazorpayOrder(previousRazorpayOrderId, req.user._id);
      const expected = Math.round(all.reduce((sum, o) => sum + Number(o.total || 0), 0) * 100);
      if (Number(captured.amount) === expected && String(captured.currency || '') === 'INR') {
        await markCheckoutPaid(all, captured.id, captured.amount);
        return res.status(409).json({ success: false, alreadyPaid: true, paymentStatus: 'paid', message: 'Your earlier payment went through. No need to pay again.' });
      }
    }
  }

  const amount = live.reduce((sum, o) => sum + Number(o.total || 0), 0);
  const rpOrder = await createRazorpayOrder(amount, live[0].orderNumber || live[0]._id, {
    userId: String(req.user._id),
    orderIds: live.map(o => String(o._id)).join(',').slice(0, 240),
  });

  // Keep the old Razorpay order id in history so a late capture on it is
  // still matched (and refunded if this new payment also succeeds).
  const update = {
    $set: { razorpayOrderId: rpOrder.id, paymentStatus: 'pending', razorpayPaymentId: '' },
    ...(previousRazorpayOrderId ? { $addToSet: { razorpayOrderIdHistory: previousRazorpayOrderId } } : {}),
  };
  const result = await Order.updateMany(
    {
      _id: { $in: live.map(o => o._id) },
      razorpayOrderId: previousRazorpayOrderId,
      paymentStatus: { $nin: ['paid', 'refunded'] },
      status: { $ne: 'cancelled' },
    },
    update
  );
  if (result.modifiedCount !== live.length) {
    return res.status(409).json({ success: false, message: 'Payment status changed while retrying. Please refresh My Orders.' });
  }

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

  // ── Refund lifecycle events ──────────────────────────────────────────
  // refund.processed / refund.failed carry a refund entity (not a payment
  // entity). Handle and return here so the payment.* amount checks below never
  // run against a refund event. Orders are matched by the orderId we stamped
  // into the refund notes at initiation (exact even for a partial refund of one
  // order in a multi-restaurant checkout), falling back to the stored refund id.
  if (typeof event.event === 'string' && event.event.startsWith('refund.')) {
    const refundEntity = event?.payload?.refund?.entity;
    if (!refundEntity) return res.json({ success: true, ignored: true });

    const refundId = String(refundEntity.id || '');
    const notesOrderId = refundEntity.notes && refundEntity.notes.orderId ? String(refundEntity.notes.orderId) : '';

    let targets = [];
    if (notesOrderId) targets = await Order.find({ _id: notesOrderId });
    if (!targets.length && refundId) targets = await Order.find({ 'refund.razorpayRefundId': refundId });
    if (!targets.length) return res.json({ success: true, ignored: true });

    const ids = targets.map(o => o._id);
    if (event.event === 'refund.processed' || refundEntity.status === 'processed') {
      await Order.updateMany(
        { _id: { $in: ids } },
        { $set: {
            paymentStatus: 'refunded',
            'refund.status': 'completed',
            'refund.razorpayRefundId': refundId,
            'refund.completedAt': new Date(),
        } }
      );
      for (const id of ids) {
        const updated = await Order.findById(id);
        if (updated) await applyRefundAdjustment(updated);
      }
    } else if (event.event === 'refund.failed' || refundEntity.status === 'failed') {
      await Order.updateMany(
        { _id: { $in: ids } },
        { $set: { 'refund.status': 'failed', 'refund.razorpayRefundId': refundId } }
      );
    }
    return res.json({ success: true });
  }

  const paymentEntity = event?.payload?.payment?.entity;
  if (!paymentEntity) return res.json({ success: true, ignored: true });

  const razorpayOrderId = String(paymentEntity.order_id || '');
  const paymentId = String(paymentEntity.id || '');
  if (!razorpayOrderId || !paymentId) return res.json({ success: true, ignored: true });

  const orders = await ordersForRazorpayOrder(razorpayOrderId);
  if (!orders.length) return res.json({ success: true, ignored: true });

  const expectedAmount = Math.round(orders.reduce((sum, o) => sum + Number(o.total || 0), 0) * 100);
  const actualAmount = Number(paymentEntity.amount || 0);
  if (actualAmount !== expectedAmount || String(paymentEntity.currency || '') !== 'INR') {
    return res.status(400).json({ success: false, message: 'Webhook amount/currency mismatch.' });
  }

  if (event.event === 'payment.captured' || paymentEntity.status === 'captured') {
    await markCheckoutPaid(orders, paymentId, actualAmount);
  } else if (event.event === 'payment.failed') {
    // Only the orders whose CURRENT Razorpay order failed. A failure on an old
    // (retried) Razorpay order must not mark the new attempt as failed.
    await Order.updateMany(
      { _id: { $in: orders.map(o => o._id) }, razorpayOrderId, paymentStatus: { $nin: ['paid', 'refunded'] } },
      { $set: { paymentStatus: 'failed', razorpayPaymentId: paymentId } }
    );
  }

  return res.json({ success: true });
});

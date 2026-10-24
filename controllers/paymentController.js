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
const { RESTAURANT_RESPONSE_WINDOW_MS, deadlinesFrom } = require('../services/orderCancellationPolicy');
const { releaseOrderToRestaurant } = require('../services/restaurantHandoffService');

function publicPayment(order) {
  return {
    provider: 'razorpay',
    keyId: process.env.RAZORPAY_KEY_ID || '',
    orderId: order.razorpayOrderId || '',
    amount: toPaise(Number(order.partialCodAdvanceAmount || 0) > 0 ? order.partialCodAdvanceAmount : order.total),
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
  // A repeated event for the SAME settled payment must still resume the
  // post-capture work below (coupon claim, cart clear, and notification enqueue).
  // Otherwise a process crash after setting paymentStatus='paid' can permanently
  // skip those effects. Notification service dedupe keys make replay safe.
  const alreadySettledBySamePayment = liveOrders.length > 0
    && liveUnpaid.length === 0
    && liveOrders.every(o => o.razorpayPaymentId === pid);

  // Atomically elect exactly one captured payment as the owner of this checkout.
  // This closes the webhook/verify race where payment A and payment B both read
  // an unpaid checkout before either request writes paymentStatus='paid'.
  // A retry of the SAME payment id is allowed to continue an interrupted claim.
  const liveLeader = liveUnpaid[0] || liveOrders[0];
  if (!liveLeader) {
    // Every order in this checkout is already cancelled but Razorpay has captured
    // money. Record it for traceability and refund it; never silently acknowledge.
    await Order.updateMany(
      { _id: { $in: ids }, status: 'cancelled', paymentStatus: { $nin: ['paid', 'refunded'] } },
      { $set: { paymentStatus: 'paid', razorpayPaymentId: pid } }
    );
    const deadOrders = (await Order.find({ _id: { $in: ids } }))
      .filter(o => o.status === 'cancelled' && o.razorpayPaymentId === pid);
    for (const o of deadOrders) {
      await initiateOrderRefund(o, 'Payment received after the order was cancelled');
    }
    return { liveOrderIds: [], refundedOrderIds: deadOrders.map(o => o._id), duplicate: false };
  }

  if (!alreadySettledBySamePayment) {
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

    if (!claim) {
      // A same-payment claimant may have won the race and then been interrupted;
      // resume its work. A different payment ID means this capture is duplicate.
      const currentLeader = await Order.findById(liveLeader._id).select('paymentClaimId paymentStatus razorpayPaymentId');
      if (currentLeader && String(currentLeader.paymentClaimId || '') !== pid) {
        await refundDuplicatePayment(ids, pid, Number(amountPaise || 0) / 100);
        return { liveOrderIds: [], refundedOrderIds: [], duplicate: true };
      }
    }
  }

  const unpaid = { $nin: ['paid', 'refunded'] };
  const responseDeadline = new Date(Date.now() + RESTAURANT_RESPONSE_WINDOW_MS);
  await Order.updateMany(
    { _id: { $in: ids }, paymentStatus: unpaid, status: { $ne: 'cancelled' } },
    { $set: { paymentStatus: 'paid', razorpayPaymentId: pid, restaurantResponseDeadline: responseDeadline } }
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

    // Re-enqueue notifications on a same-payment retry as well: the first worker
    // may have crashed after persisting payment state. These functions use durable
    // dedupe keys, so this repairs the crash window without duplicate delivery.
    for (const o of live) {
      pushService.notifyRestaurantNewOrder(o).catch((err) => console.error('[PUSH] vendor new-order:', err.message));
      pushService.notifyAdminsNewOrder(o).catch((err) => console.error('[PUSH] admin-new-order:', err.message));
    }
  }

  return {
    liveOrderIds: live.map(o => o._id),
    refundedOrderIds: cancelled.map(o => o._id),
    duplicate: false,
  };
}

// Exported (not a route handler) so the abandoned-checkout sweeper can settle a
// late capture through the exact same paid path as the webhook.
exports.markCheckoutPaid = markCheckoutPaid;
// Same for a partial-COD advance that Razorpay captured after the customer left.
exports.markPartialCodAdvancePaid = markPartialCodAdvancePaid;


async function markPartialCodAdvancePaid(order, paymentId) {
  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, paymentMethod: 'cod', partialCodAdvanceAmount: { $gt: 0 }, partialCodAdvanceStatus: 'pending', status: { $ne: 'cancelled' } },
    { $set: { partialCodAdvanceStatus: 'paid', partialCodAdvancePaidAt: new Date(), razorpayPaymentId: String(paymentId), paymentStatus: 'cod_pending' } },
    { new: true }
  );
  if (claimed) {
    // The advance is now captured, so the order is committed: start the
    // restaurant's response window and notify. Idempotent (see the service).
    await releaseOrderToRestaurant(claimed);
    return { paid: true, order: claimed };
  }
  const current = await Order.findById(order._id);
  if (current?.partialCodAdvanceStatus === 'paid' && current.razorpayPaymentId === String(paymentId)) return { paid: true, alreadyPaid: true, order: current };
  if (current?.partialCodAdvanceStatus === 'paid' && current.razorpayPaymentId && current.razorpayPaymentId !== String(paymentId)) {
    await refundDuplicatePayment([current._id], paymentId, Number(current.partialCodAdvanceAmount || 0), 'Duplicate partial-COD advance payment');
    return { paid: false, duplicate: true, order: current };
  }
  // If the order was cancelled before the capture arrived, the payment must
  // never reactivate it. Refund the late capture and leave the order cancelled.
  if (current?.status === 'cancelled') {
    if (current.partialCodRefundEligible === true) {
      const cancelledPaid = await Order.findOneAndUpdate({ _id: current._id, status: 'cancelled', partialCodAdvanceStatus: 'pending', razorpayPaymentId: { $in: ['', null] } }, { $set: { partialCodAdvanceStatus: 'paid', partialCodAdvancePaidAt: new Date(), razorpayPaymentId: String(paymentId) } }, { new: true });
      if (cancelledPaid) await initiateOrderRefund(cancelledPaid, 'Partial-COD advance captured after pre-acceptance cancellation');
    }
    return { paid: false, cancelled: true, order: current };
  }
  return { paid: false, order: current };
}

exports.verifyPayment = asyncHandler(async (req, res) => {
  assertConfigured();
  const { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature } = req.body || {};
  if (!orderId || !razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
    return res.status(400).json({ success: false, message: 'Payment verification fields are required.' });
  }

  const orders = await findCheckoutOrders(req.user._id, orderId, razorpayOrderId);
  if (!orders || !orders.length) return res.status(404).json({ success: false, message: 'Order not found.' });
  const isPartialCod = orders[0].paymentMethod === 'cod' && Number(orders[0].partialCodAdvanceAmount || 0) > 0;
  if (orders[0].paymentMethod === 'cod' && !isPartialCod) return res.status(400).json({ success: false, message: 'This order does not use online payment.' });

  const knownIds = new Set(orders.flatMap(o => [o.razorpayOrderId, ...(o.razorpayOrderIdHistory || [])]).filter(Boolean));
  if (!knownIds.has(String(razorpayOrderId))) {
    return res.status(400).json({ success: false, message: 'Razorpay order mismatch.' });
  }
  const storedRazorpayOrderId = String(razorpayOrderId);

  if (isPartialCod && orders[0].partialCodAdvanceStatus === 'paid' && orders[0].razorpayPaymentId === String(razorpayPaymentId)) {
    return res.json({ success: true, alreadyPaid: true, paymentStatus: 'cod_pending', partialCodAdvanceStatus: 'paid', orderIds: orders.map(o => o._id) });
  }
  const liveOrders = orders.filter(o => o.status !== 'cancelled');
  if (!isPartialCod && liveOrders.length && liveOrders.every(o => o.paymentStatus === 'paid' && o.razorpayPaymentId === String(razorpayPaymentId))) {
    return res.json({ success: true, alreadyPaid: true, paymentStatus: 'paid', orderIds: orders.map(o => o._id) });
  }

  if (!verifyRazorpaySignature(storedRazorpayOrderId, razorpayPaymentId, razorpaySignature)) {
    return res.status(400).json({ success: false, message: 'Invalid payment signature.' });
  }

  const payment = await fetchPayment(razorpayPaymentId);
  const expectedAmount = isPartialCod
    ? Math.round(Number(orders[0].partialCodAdvanceAmount || 0) * 100)
    : Math.round(orders.reduce((sum, o) => sum + Number(o.total || 0), 0) * 100);
  if (String(payment.order_id || '') !== storedRazorpayOrderId) {
    return res.status(400).json({ success: false, message: 'Payment belongs to a different Razorpay order.' });
  }
  if (Number(payment.amount) !== expectedAmount || String(payment.currency || '') !== 'INR') {
    return res.status(400).json({ success: false, message: 'Payment amount or currency does not match the server total.' });
  }
  if (payment.status !== 'captured') {
    // A failed attempt does NOT cancel the order: the customer can retry payment on it
    // (retryPayment) and the abandoned-checkout sweeper expires it if they never do.
    if (payment.status === 'failed' && isPartialCod) {
      await Order.updateOne({ _id: orders[0]._id, razorpayOrderId: storedRazorpayOrderId, partialCodAdvanceStatus: 'pending', status: { $ne: 'cancelled' } }, { $set: { partialCodAdvanceStatus: 'pending' } });
      return res.status(409).json({ success: false, message: 'Advance payment failed. You can retry the advance payment.', partialCodAdvanceStatus: 'pending' });
    }
    if (payment.status === 'failed') {
      const current = await Order.findOne({ _id: orders[0]._id }).select('status');
      return res.status(409).json({
        success: false,
        retryable: true,
        message: 'Payment failed. You can retry the payment.',
        paymentStatus: 'failed',
        orderStatus: current?.status || 'placed',
      });
    }
    return res.status(409).json({ success: false, message: `Payment is ${payment.status || 'not captured yet'}.`, paymentStatus: payment.status || 'pending' });
  }

  if (isPartialCod) {
    const result = await markPartialCodAdvancePaid(orders[0], razorpayPaymentId);
    if (!result.paid) return res.status(409).json({ success: false, message: result.cancelled ? 'Order was cancelled; the late advance payment is being refunded.' : 'Advance payment could not be applied to this order.' });
    return res.json({ success: true, paymentStatus: 'cod_pending', partialCodAdvanceStatus: 'paid', advancePaid: Number(orders[0].partialCodAdvanceAmount || 0), cashDueAtDelivery: Number(orders[0].partialCodCashDue || 0), orderIds: orders.map(o => o._id), razorpayPaymentId });
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
  const isPartialCod = orders[0].paymentMethod === 'cod' && Number(orders[0].partialCodAdvanceAmount || 0) > 0;
  if (orders[0].paymentMethod === 'cod' && !isPartialCod) return res.status(400).json({ success: false, message: 'COD orders do not need online payment.' });
  if (isPartialCod && orders[0].partialCodAdvanceStatus === 'paid') return res.status(409).json({ success: false, message: 'The COD advance is already paid.' });
  if (!isPartialCod && orders.some(o => isSettledPayment(o))) return res.status(409).json({ success: false, message: 'This checkout is already paid.' });

  // A payment-failed order is intentionally stored as `cancelled` so it can
  // never enter the restaurant's live queue. It is still retryable by the
  // same customer. Other cancelled orders remain permanently cancelled.
  const retryableCancelled = orders.filter(o =>
    !isPartialCod && o.status === 'cancelled' &&
    o.paymentStatus === 'failed' &&
    String(o.cancelReason || '') === 'Payment failed'
  );
  const live = orders.filter(o => o.status !== 'cancelled');
  const retryable = [...live, ...retryableCancelled];
  if (!retryable.length) return res.status(409).json({ success: false, message: 'This order has been cancelled.' });

  // Launch-fix: before opening a NEW Razorpay order, check whether the current
  // one was actually paid (UPI can confirm late). If so, record that payment
  // instead of asking the customer to pay twice.
  const previousRazorpayOrderId = retryable[0].razorpayOrderId || '';
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
      const expected = isPartialCod ? Math.round(Number(all[0]?.partialCodAdvanceAmount || 0) * 100) : Math.round(all.reduce((sum, o) => sum + Number(o.total || 0), 0) * 100);
      if (Number(captured.amount) === expected && String(captured.currency || '') === 'INR') {
        if (isPartialCod) {
          await markPartialCodAdvancePaid(all[0], captured.id);
          return res.status(409).json({ success: false, alreadyPaid: true, partialCodAdvanceStatus: 'paid', message: 'Your earlier advance payment went through. No need to pay again.' });
        }
        const settled = await markCheckoutPaid(all, captured.id, captured.amount);
        if (!settled.liveOrderIds.length && settled.refundedOrderIds.length) {
          return res.status(409).json({ success: false, refunded: true, paymentStatus: 'refunded', message: 'This order was cancelled, so your payment is being refunded. Please place a new order.' });
        }
        return res.status(409).json({ success: false, alreadyPaid: true, paymentStatus: 'paid', message: 'Your earlier payment went through. No need to pay again.' });
      }
    }
  }

  const amount = isPartialCod ? Number(retryable[0].partialCodAdvanceAmount || 0) : retryable.reduce((sum, o) => sum + Number(o.total || 0), 0);
  const rpOrder = await createRazorpayOrder(amount, retryable[0].orderNumber || retryable[0]._id, {
    userId: String(req.user._id),
    orderIds: retryable.map(o => String(o._id)).join(',').slice(0, 240),
  });

  // Revive only orders that were cancelled specifically because the previous
  // payment failed. They become `placed`/`pending` for the NEW Razorpay order.
  // Genuine customer/restaurant cancellations stay cancelled.
  const retryableIds = retryableCancelled.map(o => o._id);
  if (retryableIds.length) {
    await Order.updateMany(
      {
        _id: { $in: retryableIds },
        status: 'cancelled',
        paymentStatus: 'failed',
        cancelReason: 'Payment failed',
      },
      {
        $set: { status: 'placed', paymentStatus: 'pending', cancelReason: '', isCancellable: true, razorpayPaymentId: '' },
        $push: { statusHistory: { status: 'placed', note: 'Payment retry started', at: new Date() } },
      }
    );
  }

  // Keep the old Razorpay order id in history so a late capture on it is
  // still matched (and refunded if this new payment also succeeds).
  const update = {
    $set: { razorpayOrderId: rpOrder.id, paymentStatus: isPartialCod ? 'cod_pending' : 'pending', razorpayPaymentId: '', ...(isPartialCod ? { partialCodAdvanceStatus: 'pending' } : {}) },
    ...(previousRazorpayOrderId ? { $addToSet: { razorpayOrderIdHistory: previousRazorpayOrderId } } : {}),
  };
  const result = await Order.updateMany(
    {
      _id: { $in: retryable.map(o => o._id) },
      razorpayOrderId: previousRazorpayOrderId,
      paymentStatus: { $nin: ['paid', 'refunded'] },
      status: { $ne: 'cancelled' },
    },
    update
  );
  if (result.modifiedCount !== retryable.length) {
    return res.status(409).json({ success: false, message: 'Payment status changed while retrying. Please refresh My Orders.' });
  }

  return res.json({
    success: true,
    payment: { provider: 'razorpay', keyId: process.env.RAZORPAY_KEY_ID, orderId: rpOrder.id, amount: rpOrder.amount, currency: rpOrder.currency },
  });
});

exports.paymentStatus = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, user: req.user._id })
    .select('paymentMethod paymentStatus razorpayOrderId razorpayPaymentId total status cancelReason partialCodAdvanceAmount partialCodCashDue partialCodAdvanceStatus');
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

  // Reconcile terminal Razorpay failures even if the webhook arrived late or
  // was missed. This prevents an unpaid online order from remaining visibly
  // `placed` on My Orders / tracking. A still-open Razorpay order is left alone.
  if (order.paymentMethod !== 'cod' && order.paymentStatus === 'pending' && order.razorpayOrderId && order.status !== 'cancelled') {
    try {
      const attempts = await fetchOrderPayments(order.razorpayOrderId);
      const captured = attempts.find(p => p.status === 'captured');
      if (captured) {
        const expectedAmount = Math.round(Number(order.total || 0) * 100);
        if (Number(captured.amount) === expectedAmount && String(captured.currency || '') === 'INR') {
          await markCheckoutPaid([order], captured.id, captured.amount);
          const fresh = await Order.findById(order._id).select('paymentMethod paymentStatus razorpayOrderId razorpayPaymentId total status cancelReason partialCodAdvanceAmount partialCodCashDue partialCodAdvanceStatus');
          return res.json({ success: true, data: { ...publicPayment(fresh), orderId: fresh._id, paymentId: fresh.razorpayPaymentId || null, orderStatus: fresh.status, cancelReason: fresh.cancelReason || '', partialCodAdvanceAmount: Number(fresh.partialCodAdvanceAmount || 0), partialCodCashDue: Number(fresh.partialCodCashDue || 0), partialCodAdvanceStatus: fresh.partialCodAdvanceStatus } });
        }
      }

      // Failed attempts are deliberately NOT turned into a cancellation here: the customer
      // may still retry (same modal or retryPayment). An order that is never paid is expired
      // by the abandoned-checkout sweeper, which also returns the reserved stock.
    } catch (err) {
      console.warn(`[PAYMENT] status reconciliation failed for ${order.razorpayOrderId}: ${err.message}`);
    }
  }

  const fresh = await Order.findById(order._id).select('paymentMethod paymentStatus razorpayOrderId razorpayPaymentId total status cancelReason partialCodAdvanceAmount partialCodCashDue partialCodAdvanceStatus');
  res.json({
    success: true,
    data: {
      ...publicPayment(fresh),
      orderId: fresh._id,
      paymentId: fresh.razorpayPaymentId || null,
      orderStatus: fresh.status,
      cancelReason: fresh.cancelReason || '',
      partialCodAdvanceAmount: Number(fresh.partialCodAdvanceAmount || 0),
      partialCodCashDue: Number(fresh.partialCodCashDue || 0),
      partialCodAdvanceStatus: fresh.partialCodAdvanceStatus,
    },
  });
});

exports.handleWebhook = asyncHandler(async (req, res) => {
  // HMAC must cover the exact provider bytes. Re-serializing parsed JSON is not
  // equivalent and can make signature handling inconsistent; fail closed when
  // the raw parser did not run.
  if (!Buffer.isBuffer(req.body)) {
    return res.status(400).json({ success: false, message: 'Raw webhook body is required.' });
  }
  const rawBody = req.body;
  const signature = req.get('x-razorpay-signature');
  if (!verifyWebhookSignature(rawBody, signature)) {
    return res.status(400).json({ success: false, message: 'Invalid webhook signature.' });
  }

  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); }
  catch (_) { return res.status(400).json({ success: false, message: 'Invalid webhook payload.' }); }

  // Refund lifecycle events are independent of the payment.captured flow. The
  // refund type stamped in provider notes selects the corresponding order state;
  // we never infer a full-order cancellation from a support partial refund.
  if (typeof event.event === 'string' && event.event.startsWith('refund.')) {
    const refundEntity = event?.payload?.refund?.entity;
    if (!refundEntity) return res.json({ success: true, ignored: true });

    const refundId = String(refundEntity.id || '');
    const providerPaymentId = String(refundEntity.payment_id || '');
    const notes = refundEntity.notes && typeof refundEntity.notes === 'object' ? refundEntity.notes : {};
    const notesOrderId = String(notes.orderId || '');
    let refundType = String(notes.refundType || '');
    const amountPaise = Number(refundEntity.amount);
    const terminalState = event.event === 'refund.processed' || refundEntity.status === 'processed'
      ? 'processed'
      : (event.event === 'refund.failed' || refundEntity.status === 'failed' ? 'failed' : '');

    if (!refundId || !Number.isSafeInteger(amountPaise) || amountPaise <= 0 || !terminalState) {
      return res.json({ success: true, ignored: true });
    }

    let targets = [];
    if (notesOrderId) {
      try { targets = await Order.find({ _id: notesOrderId }); }
      catch (err) { console.warn('[PAYMENT] refund webhook has invalid orderId note'); }
    }
    if (!targets.length) {
      const alternatives = [{ 'refund.razorpayRefundId': refundId }, { 'supportRefund.razorpayRefundId': refundId }, { 'duplicatePayments.refundId': refundId }];
      if (providerPaymentId) alternatives.push({ 'duplicatePayments.paymentId': providerPaymentId });
      targets = await Order.find({ $or: alternatives });
    }
    if (!targets.length) return res.json({ success: true, ignored: true });

    // Backwards compatibility for already-issued refunds whose Razorpay notes
    // predate refundType. Only infer a lifecycle when the matching stored refund
    // ID, or exactly one active matching amount/lifecycle, disambiguates it.
    if (!refundType) {
      const stored = targets.find(o => String(o.supportRefund?.razorpayRefundId || '') === refundId
        || String(o.refund?.razorpayRefundId || '') === refundId
        || (o.duplicatePayments || []).some(d => String(d.refundId || '') === refundId));
      if (stored) {
        if (String(stored.supportRefund?.razorpayRefundId || '') === refundId) refundType = 'support';
        else if ((stored.duplicatePayments || []).some(d => String(d.refundId || '') === refundId)) refundType = 'duplicate_payment';
        else refundType = Number(stored.partialCodAdvanceAmount || 0) > 0 ? 'partial_cod_cancellation' : 'order_cancellation';
      } else {
        const candidates = targets.flatMap(o => {
          const possible = [];
          if (o.supportRefund?.status === 'processing' && Math.round(Number(o.supportRefund.amount || 0) * 100) === amountPaise) possible.push('support');
          if (o.refund?.status === 'processing' && Math.round(Number(o.refund.amount || 0) * 100) === amountPaise) possible.push(Number(o.partialCodAdvanceAmount || 0) > 0 ? 'partial_cod_cancellation' : 'order_cancellation');
          if ((o.duplicatePayments || []).some(d => d.status === 'processing' && Math.round(Number(d.amount || 0) * 100) === amountPaise && (!providerPaymentId || String(d.paymentId) === providerPaymentId))) possible.push('duplicate_payment');
          return possible.map(type => ({ order: o, type }));
        });
        const uniqueTypes = [...new Set(candidates.map(c => c.type))];
        if (uniqueTypes.length === 1) refundType = uniqueTypes[0];
        else {
          console.warn(`[PAYMENT] refund webhook ${refundId} lacks refundType and cannot be safely disambiguated`);
          return res.json({ success: true, ignored: true, reason: 'ambiguous_legacy_refund' });
        }
      }
    }

    if (refundType === 'duplicate_payment') {
      const duplicatePaymentId = String(notes.paymentId || providerPaymentId || '');
      if (!duplicatePaymentId) return res.json({ success: true, ignored: true });
      for (const target of targets) {
        const entry = (target.duplicatePayments || []).find(d => String(d.paymentId) === duplicatePaymentId);
        if (!entry || Math.round(Number(entry.amount || 0) * 100) !== amountPaise) continue;
        if (entry.status === 'completed') continue; // Never downgrade a completed refund.
        if (entry.status !== 'processing') continue;
        await Order.updateOne(
          { _id: target._id, duplicatePayments: { $elemMatch: { paymentId: duplicatePaymentId, status: 'processing' } } },
          { $set: {
            'duplicatePayments.$.status': terminalState === 'processed' ? 'completed' : 'failed',
            'duplicatePayments.$.refundId': refundId,
            'duplicatePayments.$.error': terminalState === 'failed' ? 'Razorpay reported refund.failed' : '',
          } }
        );
      }
      return res.json({ success: true });
    }

    if (!['support', 'order_cancellation', 'partial_cod_cancellation'].includes(refundType)) {
      console.warn(`[PAYMENT] refund webhook ${refundId} has unknown refundType`);
      return res.json({ success: true, ignored: true, reason: 'unknown_refund_type' });
    }

    for (const target of targets) {
      const isSupport = refundType === 'support';
      const isPartialCod = refundType === 'partial_cod_cancellation';
      const lifecycle = isSupport ? target.supportRefund : target.refund;
      if (!lifecycle || Math.round(Number(lifecycle.amount || 0) * 100) !== amountPaise) continue;
      if (providerPaymentId && target.razorpayPaymentId && String(target.razorpayPaymentId) !== providerPaymentId) continue;
      const matchingStoredRefundId = String(lifecycle.razorpayRefundId || '');
      if (matchingStoredRefundId && matchingStoredRefundId !== refundId) continue;

      if (terminalState === 'failed') {
        if (lifecycle.status !== 'processing') continue;
        const filter = isSupport
          ? { _id: target._id, 'supportRefund.status': 'processing', 'supportRefund.amount': lifecycle.amount }
          : { _id: target._id, 'refund.status': 'processing', 'refund.amount': lifecycle.amount };
        const set = isSupport
          ? { 'supportRefund.status': 'failed', 'supportRefund.razorpayRefundId': refundId, 'supportRefund.error': 'Razorpay reported refund.failed' }
          : { 'refund.status': 'failed', 'refund.razorpayRefundId': refundId, 'refund.reason': 'Razorpay reported refund.failed', ...(isPartialCod ? { partialCodAdvanceStatus: 'refund_failed' } : {}) };
        await Order.updateOne(filter, { $set: set });
        continue;
      }

      if (lifecycle.status === 'completed' && matchingStoredRefundId === refundId) {
        // The synchronous Razorpay response may have completed the refund before
        // this webhook arrives. Re-running the ledger adjustment is safe because
        // the settlement ledger has a unique order/source key.
        if (isSupport && Number(target.supportRefund.amount || 0) >= Number(target.total || 0) - 0.01) {
          await applyRefundAdjustment(target).catch(err => console.error(`[REFUND] ledger adjustment retry failed order=${target._id}: ${err.message}`));
        } else if (!isSupport && !isPartialCod) {
          await applyRefundAdjustment(target).catch(err => console.error(`[REFUND] ledger adjustment retry failed order=${target._id}: ${err.message}`));
        }
        continue;
      }
      if (lifecycle.status !== 'processing') continue;
      if (matchingStoredRefundId && matchingStoredRefundId !== refundId) continue;

      const filter = isSupport
        ? { _id: target._id, paymentStatus: 'paid', 'supportRefund.status': 'processing', 'supportRefund.amount': lifecycle.amount }
        : { _id: target._id, status: 'cancelled', 'refund.status': 'processing', 'refund.amount': lifecycle.amount };
      if (providerPaymentId) filter.razorpayPaymentId = providerPaymentId;
      const set = isSupport
        ? {
            'supportRefund.status': 'completed',
            'supportRefund.razorpayRefundId': refundId,
            'supportRefund.completedAt': new Date(),
            'supportRefund.error': '',
            ...(Number(target.supportRefund.amount || 0) >= Number(target.total || 0) - 0.01 ? { paymentStatus: 'refunded' } : {}),
          }
        : {
            'refund.status': 'completed',
            'refund.razorpayRefundId': refundId,
            'refund.completedAt': new Date(),
            ...(isPartialCod ? { partialCodAdvanceStatus: 'refunded' } : { paymentStatus: 'refunded' }),
          };
      const result = await Order.updateOne(filter, { $set: set });
      if (result?.matchedCount || result?.modifiedCount) {
        const updated = await Order.findById(target._id);
        if (updated && (isPartialCod === false) && (!isSupport || Number(updated.supportRefund?.amount || 0) >= Number(updated.total || 0) - 0.01)) {
          await applyRefundAdjustment(updated).catch(err => console.error(`[REFUND] ledger adjustment failed order=${target._id}: ${err.message}`));
        }
      }
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

  const isPartialCod = orders.length === 1 && orders[0].paymentMethod === 'cod' && Number(orders[0].partialCodAdvanceAmount || 0) > 0;
  const expectedAmount = isPartialCod
    ? Math.round(Number(orders[0].partialCodAdvanceAmount || 0) * 100)
    : Math.round(orders.reduce((sum, o) => sum + Number(o.total || 0), 0) * 100);
  const actualAmount = Number(paymentEntity.amount || 0);
  if (actualAmount !== expectedAmount || String(paymentEntity.currency || '') !== 'INR') {
    return res.status(400).json({ success: false, message: 'Webhook amount/currency mismatch.' });
  }

  if (event.event === 'payment.captured' || paymentEntity.status === 'captured') {
    if (isPartialCod) await markPartialCodAdvancePaid(orders[0], paymentId);
    else await markCheckoutPaid(orders, paymentId, actualAmount);
  } else if (event.event === 'payment.failed' && isPartialCod) {
    await Order.updateOne({ _id: orders[0]._id, razorpayOrderId, partialCodAdvanceStatus: 'pending', status: { $ne: 'cancelled' } }, { $set: { partialCodAdvanceStatus: 'pending' } });
  } else if (event.event === 'payment.failed') {
    // ONE failed attempt must not cancel the order. Razorpay lets the customer retry
    // inside the same checkout modal (and retryPayment opens a fresh attempt); if that
    // retry succeeds, the order must still be there to receive the money. The order
    // stays `placed` / `pending` with its stock reserved. If the customer never pays,
    // services/abandonedCheckoutService.js expires it after the unpaid window, returns
    // the stock and tells the customer. Nothing to do here but acknowledge the event.
  }

  return res.json({ success: true });
});

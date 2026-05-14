const asyncHandler = require('express-async-handler');
const Order        = require('../models/Order');

/* ─────────────────────────────────────────────────────────────
 *  STRICT JWT PAYLOAD GUARD
 *  Only users with role === 'admin' or 'ceo' may proceed.
 * ───────────────────────────────────────────────────────────── */
function assertAdminPayload(req, res) {
  const ADMIN_ROLES = ['admin', 'ceo'];
  if (!req.user || !ADMIN_ROLES.includes(req.user.role)) {
    res.status(403).json({
      success: false,
      message: 'Access denied. Admin credentials required.',
    });
    return false;
  }
  return true;
}

/* ─────────────────────────────────────────────────────────────
 *  GET /api/admin/metrics
 *
 *  Returns a single JSON object with:
 *    - totalRevenue   : sum of `total` for all 'delivered' orders
 *    - ordersToday    : count of orders placed since midnight (local)
 *    - successRate    : % of terminal orders that are 'delivered'
 *                       (delivered / (delivered + cancelled) × 100)
 *    - totalOrders    : all-time order count (bonus — free with pipeline)
 *
 *  Uses three targeted aggregation pipelines to keep each
 *  $match filter lean.  All run concurrently via Promise.all.
 * ───────────────────────────────────────────────────────────── */
exports.getMetrics = asyncHandler(async (req, res) => {
  if (!assertAdminPayload(req, res)) return;

  // Midnight of the current server day (UTC)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [revenueResult, todayResult, rateResult] = await Promise.all([

    /* ── Pipeline 1: Total Revenue ────────────────────────── */
    Order.aggregate([
      { $match: { status: 'delivered' } },
      {
        $group: {
          _id:          null,
          totalRevenue: { $sum: '$total' },
          totalOrders:  { $sum: 1 },
        },
      },
    ]),

    /* ── Pipeline 2: Orders Today ─────────────────────────── */
    Order.aggregate([
      {
        $match: {
          createdAt: { $gte: todayStart },
        },
      },
      {
        $group: {
          _id:         null,
          ordersToday: { $sum: 1 },
        },
      },
    ]),

    /* ── Pipeline 3: Success Rate ─────────────────────────── */
    Order.aggregate([
      {
        $match: {
          status: { $in: ['delivered', 'cancelled'] },
        },
      },
      {
        $group: {
          _id:       '$status',
          count:     { $sum: 1 },
        },
      },
    ]),

  ]);

  /* ── Safely unpack Pipeline 1 ── */
  const revenueDoc  = Array.isArray(revenueResult) && revenueResult.length > 0
    ? revenueResult[0]
    : null;
  const totalRevenue = revenueDoc && typeof revenueDoc.totalRevenue === 'number'
    ? revenueDoc.totalRevenue
    : 0;
  const totalOrders  = revenueDoc && typeof revenueDoc.totalOrders === 'number'
    ? revenueDoc.totalOrders
    : 0;

  /* ── Safely unpack Pipeline 2 ── */
  const todayDoc    = Array.isArray(todayResult) && todayResult.length > 0
    ? todayResult[0]
    : null;
  const ordersToday = todayDoc && typeof todayDoc.ordersToday === 'number'
    ? todayDoc.ordersToday
    : 0;

  /* ── Safely unpack Pipeline 3 ── */
  let deliveredCount = 0;
  let cancelledCount = 0;

  if (Array.isArray(rateResult)) {
    for (let i = 0; i < rateResult.length; i++) {
      const row = rateResult[i];
      if (!row || typeof row !== 'object') continue;
      if (row._id === 'delivered')  deliveredCount = Number(row.count) || 0;
      if (row._id === 'cancelled')  cancelledCount = Number(row.count) || 0;
    }
  }

  const terminalTotal = deliveredCount + cancelledCount;
  const successRate   = terminalTotal > 0
    ? Math.round((deliveredCount / terminalTotal) * 100)
    : 0; // avoid NaN / divide-by-zero on a fresh DB

  res.status(200).json({
    success: true,
    data: {
      totalRevenue,   // Number  (₹)
      ordersToday,    // Number  (count)
      successRate,    // Number  (0–100 %)
      totalOrders,    // Number  (all-time delivered)
    },
  });
});

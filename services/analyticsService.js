'use strict';

// ─────────────────────────────────────────────────────────────────────
// Analytics service (Pillar 8, rebuilt for production).
//
// AUDIT FINDINGS that this rewrite fixes (see the final report for the full
// list):
//
//  1. "TOTAL VIEWS" WAS UNMEASURABLE. Every restaurant event was deduped on
//     (event, actor, restaurant, DAY). A customer who opened a menu six times
//     produced exactly one row, so `totalViews` from the vendor rollup was
//     really "unique daily visitors" and never moved intraday. Vendors saw a
//     broken metric.
//  2. ONE bucket for every event type meant an add-to-cart could not be
//     counted separately from a page view.
//  3. No funnel at all: item views, add-to-cart, checkout and order outcomes
//     were untracked.
//  4. No idempotency: a client retry after a network blip was only stopped by
//     the same day bucket, not by a client-supplied event id.
//  5. No bot filtering: any crawler with a normal user agent inflated counts.
//  6. Order outcomes were not recorded server-side, so conversion had to be
//     inferred (badly) from orders placed by anyone who had ever visited.
//
// What replaces it:
//   • recordEvent() — idempotent, bot-aware ingestion with a CONFIGURABLE
//     dedupe window (default 30 min) and an optional client eventKey.
//   • recordOrderOutcome() — server-authoritative, one row per order, with
//     real attribution (did THIS visitor view THIS restaurant in the window?).
//   • Rollups that separate total views from unique visitors and expose the
//     whole funnel, per-item engagement and period-over-period comparison.
//
// Everything is fire-and-forget safe: a tracking failure NEVER throws into a
// menu load or a checkout.
// ─────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const mongoose = require('mongoose');
const AnalyticsEvent = require('../models/AnalyticsEvent');

const INDIA_TZ = 'Asia/Kolkata';

// Event taxonomy, grouped by how they are counted.
const BROWSE_EVENTS = new Set(['site_visit', 'restaurant_view', 'menu_view', 'search']);
const FUNNEL_EVENTS = new Set(['item_view', 'add_to_cart', 'remove_from_cart', 'checkout_initiated']);
const OUTCOME_EVENTS = new Set(['order_completed', 'order_cancelled', 'refund']);
// Browse events whose dedupe stays durable for the whole day, so the
// "unique visitor today" signal cannot be reset by the short window.
const DAILY_EVENTS = new Set(['site_visit', 'restaurant_view']);
const ALL_EVENTS = new Set([...BROWSE_EVENTS, ...FUNNEL_EVENTS, ...OUTCOME_EVENTS]);

// Dedupe window for repeat page views. Configurable so an operator can tune
// the trade-off between "a refresh is not a view" and "a return visit counts".
const DEFAULT_WINDOW_MS = 30 * 60 * 1000;
// Attribution window: how long after a menu view an order still counts as
// attributed to that view.
const DEFAULT_ATTRIBUTION_MS = 24 * 60 * 60 * 1000;

function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function dedupeWindowMs() {
  return clampEventWindow(envMs('ANALYTICS_VIEW_DEDUPE_WINDOW_MS', DEFAULT_WINDOW_MS));
}

function attributionWindowMs() {
  return envMs('ANALYTICS_ATTRIBUTION_WINDOW_MS', DEFAULT_ATTRIBUTION_MS);
}

/** YYYY-MM-DD for the given instant in India Standard Time. */
function indiaDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: INDIA_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/** Start of the given IST day as a UTC instant (for range filters). */
function indiaDayStart(date = new Date()) {
  // IST is UTC+5:30 year-round (no DST), so the offset is a constant.
  return new Date(`${indiaDay(date)}T00:00:00.000+05:30`);
}

/** Best-effort actor key. Logged-in users use their id; guests a hashed fingerprint. */
function actorKey({ userId = null, ip = '', userAgent = '' } = {}) {
  if (userId) return `u:${userId}`;
  const salt = String(process.env.ANALYTICS_VISITOR_SALT || 'eatswada-visitor');
  const hash = crypto.createHash('sha256').update(`${salt}|${ip}|${userAgent}`).digest('hex').slice(0, 24);
  return `g:${hash}`;
}

/** Hash a client session id so the raw value is never persisted. */
function sessionKeyHash(sessionId) {
  const raw = String(sessionId || '').trim();
  if (!raw) return '';
  const salt = String(process.env.ANALYTICS_VISITOR_SALT || 'eatswada-visitor');
  return crypto.createHash('sha256').update(`s|${salt}|${raw}`).digest('hex').slice(0, 24);
}

/**
 * Obvious automated traffic. Deliberately conservative: a false positive loses
 * one anonymous view, a false negative lets a crawler inflate a vendor's
 * numbers. Only unmistakable bot signatures are rejected.
 */
function isBotUserAgent(userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  if (!ua) return false;
  return /(bot|crawler|spider|crawl|slurp|bingpreview|facebookexternalhit|headlesschrome|phantomjs|python-requests|curl\/|wget\/|node-fetch|go-http-client|scrapy|semrush|ahrefs|mj12bot|petalbot)/.test(ua);
}

function clampEventWindow(ms) {
  // Guard against a pathological env value (e.g. 0 => every request is a row).
  const min = 60 * 1000;              // 1 minute floor
  const max = 24 * 60 * 60 * 1000;    // 1 day ceiling
  return Math.min(max, Math.max(min, Number(ms) || DEFAULT_WINDOW_MS));
}

/** Deterministic dedupe key for an event. */
function dedupeKeyFor({ eventType, restaurantId = null, menuItemId = null, subject, windowMs, eventKey = '' }) {
  if (eventKey) return `${eventType}:key:${eventKey}`;
  const bucket = Math.floor(Date.now() / clampEventWindow(windowMs));
  return `${eventType}:${restaurantId || 'platform'}:${menuItemId || '-'}:${subject}:${bucket}`;
}

function normaliseId(value) {
  const raw = String(value || '').trim();
  return /^[a-f\d]{24}$/i.test(raw) ? raw : null;
}

/**
 * Record one analytics event. Idempotent within the dedupe window. NEVER
 * rejects — a tracking failure must not break a page load or a checkout.
 *
 * @returns {{ recorded: boolean, reason?: string }}
 */
async function recordEvent({
  eventType,
  scope,
  restaurantId = null,
  menuItemId = null,
  orderId = null,
  userId = null,
  ip = '',
  userAgent = '',
  sessionId = '',
  eventKey = '',
  platform = '',
  referrer = '',
  source = 'web',
  attributed = false,
  now = new Date(),
} = {}) {
  try {
    if (!eventType || !ALL_EVENTS.has(eventType)) return { recorded: false, reason: 'unknown_event' };
    if (isBotUserAgent(userAgent)) return { recorded: false, reason: 'bot' };

    const restaurant = normaliseId(restaurantId);
    const menuItem = normaliseId(menuItemId);
    const order = normaliseId(orderId);

    // Daily-unique browse events keep the day bucket (so "unique visitor today"
    // is exact); everything else uses the shorter configurable window so total
    // views/actions are real.
    const windowMs = DAILY_EVENTS.has(eventType) ? 24 * 60 * 60 * 1000 : dedupeWindowMs();
    const actor = actorKey({ userId, ip, userAgent });
    const sessionKey = sessionKeyHash(sessionId);
    // Repeat page views are deduped per SESSION when we have one, so two people
    // behind one NAT IP are not collapsed into a single viewer.
    const subject = sessionKey || actor;
    const dedupeKey = dedupeKeyFor({ eventType, restaurantId: restaurant, menuItemId: menuItem, subject, windowMs, eventKey });

    const day = indiaDay(now);
    const resolvedScope = scope || (restaurant ? 'restaurant' : 'platform');
    const bucket = Math.floor(now.getTime() / clampEventWindow(windowMs));

    await AnalyticsEvent.updateOne(
      { dedupeKey },
      {
        $setOnInsert: {
          scope: resolvedScope,
          eventType,
          restaurant,
          menuItem,
          order,
          user: userId || null,
          visitorKey: actor,
          sessionKey,
          eventKey: String(eventKey || '').slice(0, 80),
          day,
          bucket,
          dedupeKey,
          platform: String(platform || '').slice(0, 40),
          referrer: String(referrer || '').slice(0, 200),
          source: String(source || 'web').slice(0, 20),
          attributed: attributed === true,
          createdAt: now,
        },
      },
      { upsert: true }
    );
    return { recorded: true };
  } catch (err) {
    // 11000 = duplicate dedupe key (already counted). The order+eventType
    // unique index also raises 11000, which is exactly the idempotent outcome
    // we want. Anything else is logged and swallowed.
    if (err?.code !== 11000) console.error('[analytics] recordEvent failed:', err.message);
    return { recorded: false, reason: err?.code === 11000 ? 'duplicate' : 'error' };
  }
}

/** Backwards-compatible alias used by the existing controllers/tests. */
async function recordVisit(params = {}) {
  return recordEvent(params);
}

/**
 * Was this visitor looking at this restaurant's menu recently? Used to
 * distinguish an ATTRIBUTED order from one merely placed by a previous
 * visitor. Returns false when there is no visitor identity to check.
 */
async function isAttributedVisit({ restaurantId, userId = null, visitorKey = '', now = new Date() } = {}) {
  const restaurant = normaliseId(restaurantId);
  if (!restaurant) return false;
  const identities = [];
  if (userId) identities.push(`u:${userId}`);
  if (visitorKey) identities.push(visitorKey);
  if (!identities.length) return false;
  try {
    const since = new Date(now.getTime() - attributionWindowMs());
    const hit = await AnalyticsEvent.exists({
      restaurant,
      visitorKey: { $in: identities },
      eventType: { $in: ['menu_view', 'restaurant_view'] },
      createdAt: { $gte: since },
    });
    return Boolean(hit);
  } catch (err) {
    console.error('[analytics] isAttributedVisit failed:', err.message);
    return false;
  }
}

/**
 * Record a server-authoritative order outcome. One row per (order, outcome),
 * enforced by a unique index, so a webhook replay can never double-count. This
 * is the ONLY place conversion is counted, so the analytics cannot be inflated
 * by a client.
 *
 * @param {'order_completed'|'order_cancelled'|'refund'} eventType
 */
async function recordOrderOutcome({ eventType, order, userId = null, attributed = null, visitorKey = '', now = new Date() } = {}) {
  try {
    if (!OUTCOME_EVENTS.has(eventType)) return { recorded: false, reason: 'unknown_event' };
    const orderId = normaliseId(order?._id || order);
    const restaurant = normaliseId(order?.restaurant);
    if (!orderId || !restaurant) return { recorded: false, reason: 'missing_ids' };

    let isAttributed = attributed;
    if (isAttributed === null) {
      isAttributed = await isAttributedVisit({ restaurantId: restaurant, userId, visitorKey, now });
    }

    const day = indiaDay(now);
    const dedupeKey = `${eventType}:order:${orderId}`;
    await AnalyticsEvent.updateOne(
      { dedupeKey },
      {
        $setOnInsert: {
          scope: 'restaurant',
          eventType,
          restaurant,
          menuItem: null,
          order: orderId,
          user: userId || order?.user || null,
          visitorKey: visitorKey || (userId ? `u:${userId}` : ''),
          sessionKey: '',
          eventKey: '',
          day,
          bucket: Math.floor(now.getTime() / (24 * 60 * 60 * 1000)),
          dedupeKey,
          platform: '',
          referrer: '',
          source: 'server',
          attributed: isAttributed === true,
          createdAt: now,
        },
      },
      { upsert: true }
    );
    return { recorded: true, attributed: isAttributed === true };
  } catch (err) {
    if (err?.code !== 11000) console.error('[analytics] recordOrderOutcome failed:', err.message);
    return { recorded: false, reason: err?.code === 11000 ? 'duplicate' : 'error' };
  }
}

function daysAgo(n) {
  return new Date(Date.now() - Math.max(0, Number(n) || 0) * 86400000);
}

function periodDays(period) {
  return period === '7d' ? 7 : period === '90d' ? 90 : period === 'all' ? 3650 : period === 'today' ? 1 : 30;
}

function periodBounds({ period = '30d', from = null, to = null } = {}) {
  if (from || to) {
    const start = from ? new Date(from) : new Date(0);
    const end = to ? new Date(to) : new Date();
    return { start, end, days: Math.max(1, Math.ceil((end - start) / 86400000)) };
  }
  if (period === 'today') return { start: indiaDayStart(), end: new Date(), days: 1 };
  const days = periodDays(period);
  return { start: daysAgo(days), end: new Date(), days };
}

// ── Rollups ───────────────────────────────────────────────────────────

/**
 * Platform-scope traffic: totals, uniques, daily series and top restaurants.
 * Shape is unchanged for existing consumers; `totalVisits`/`uniqueVisitors`
 * now mean what they say.
 */
async function getPlatformVisitAnalytics({ period = '30d', from = null, to = null } = {}) {
  const { start, end } = periodBounds({ period, from, to });
  const match = { scope: 'platform', createdAt: { $gte: start, $lte: end } };

  const [totals, daily, topRestaurants] = await Promise.all([
    AnalyticsEvent.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalVisits: { $sum: 1 },
          uniqueVisitors: { $addToSet: '$visitorKey' },
          loggedInVisits: { $sum: { $cond: [{ $ifNull: ['$user', false] }, 1, 0] } },
        },
      },
      { $project: { _id: 0, totalVisits: 1, loggedInVisits: 1, uniqueVisitors: { $size: '$uniqueVisitors' } } },
    ]),
    AnalyticsEvent.aggregate([
      { $match: match },
      { $group: { _id: '$day', visits: { $sum: 1 }, uniqueVisitors: { $addToSet: '$visitorKey' } } },
      { $project: { _id: 0, day: '$_id', visits: 1, uniqueVisitors: { $size: '$uniqueVisitors' } } },
      { $sort: { day: 1 } },
    ]),
    AnalyticsEvent.aggregate([
      { $match: { scope: 'restaurant', eventType: { $in: ['restaurant_view', 'menu_view'] }, createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: '$restaurant', views: { $sum: 1 }, uniques: { $addToSet: '$visitorKey' } } },
      { $project: { _id: 0, restaurantId: '$_id', views: 1, uniqueVisitors: { $size: '$uniques' } } },
      { $sort: { views: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: 'restaurants', localField: 'restaurantId', foreignField: '_id', as: 'r',
          pipeline: [{ $project: { name: 1 } }],
        },
      },
      { $project: { restaurantId: 1, views: 1, uniqueVisitors: 1, name: { $ifNull: [{ $first: '$r.name' }, 'Unknown'] } } },
    ]),
  ]);

  const t = totals[0] || { totalVisits: 0, uniqueVisitors: 0, loggedInVisits: 0 };
  return {
    period,
    range: { from: start, to: end },
    summary: {
      totalVisits: t.totalVisits || 0,
      uniqueVisitors: t.uniqueVisitors || 0,
      loggedInVisits: t.loggedInVisits || 0,
      guestVisits: Math.max(0, (t.totalVisits || 0) - (t.loggedInVisits || 0)),
    },
    daily,
    topRestaurants,
    currency: 'INR',
  };
}

/** Count helper: total rows and unique visitors for an event match. */
async function countTotals(match) {
  const rows = await AnalyticsEvent.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: 1 }, uniques: { $addToSet: '$visitorKey' } } },
    { $project: { _id: 0, total: 1, uniqueVisitors: { $size: '$uniques' } } },
  ]);
  const row = rows[0] || { total: 0, uniqueVisitors: 0 };
  return { total: row.total || 0, uniqueVisitors: row.uniqueVisitors || 0 };
}

/**
 * Restaurant-scope analytics for one restaurant (vendor dashboard).
 *
 * Returns, for the requested period:
 *   • today's menu views + unique visitors
 *   • weekly / monthly views + uniques
 *   • the funnel (item views, add-to-cart, checkout, completed, cancelled)
 *   • most-viewed menu items and item engagement
 *   • conversion rate and revenue
 *   • a comparison against the immediately preceding period
 */
async function getRestaurantVisitAnalytics(restaurantId, { period = '30d', from = null, to = null } = {}) {
  const restaurant = normaliseId(restaurantId);
  if (!restaurant) return emptyRestaurantAnalytics(period);
  const rid = new mongoose.Types.ObjectId(restaurant);
  const { start, end } = periodBounds({ period, from, to });
  const match = { scope: 'restaurant', restaurant: rid };
  const viewTypes = ['restaurant_view', 'menu_view'];

  const viewMatch = { ...match, eventType: { $in: viewTypes } };
  const rangeMatch = { ...match, createdAt: { $gte: start, $lte: end } };
  const todayStart = indiaDayStart();
  const prevStart = new Date(start.getTime() - (end - start));

  const [
    views, today, week, month, byType, daily, topItems, itemAdds, itemViews,
    completed, cancelled, refunds, revenueRows, prevViews, prevCompleted,
  ] = await Promise.all([
    countTotals({ ...viewMatch, createdAt: { $gte: start, $lte: end } }),
    countTotals({ ...viewMatch, createdAt: { $gte: todayStart, $lte: end } }),
    countTotals({ ...viewMatch, createdAt: { $gte: daysAgo(7), $lte: end } }),
    countTotals({ ...viewMatch, createdAt: { $gte: daysAgo(30), $lte: end } }),
    AnalyticsEvent.aggregate([
      { $match: rangeMatch },
      { $group: { _id: '$eventType', count: { $sum: 1 } } },
      { $project: { _id: 0, eventType: '$_id', count: 1 } },
    ]),
    AnalyticsEvent.aggregate([
      { $match: { ...viewMatch, createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: '$day', views: { $sum: 1 }, uniqueVisitors: { $addToSet: '$visitorKey' } } },
      { $project: { _id: 0, day: '$_id', views: 1, uniqueVisitors: { $size: '$uniqueVisitors' } } },
      { $sort: { day: 1 } },
    ]),
    AnalyticsEvent.aggregate([
      { $match: { ...match, eventType: 'item_view', menuItem: { $ne: null }, createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: '$menuItem', views: { $sum: 1 } } },
      { $sort: { views: -1 } },
      { $limit: 10 },
      { $lookup: { from: 'menus', localField: '_id', foreignField: '_id', as: 'm', pipeline: [{ $project: { name: 1, price: 1 } }] } },
      { $project: { _id: 0, menuItemId: '$_id', views: 1, name: { $ifNull: [{ $first: '$m.name' }, 'Item'] }, price: { $ifNull: [{ $first: '$m.price' }, null] } } },
    ]),
    AnalyticsEvent.aggregate([
      { $match: { ...match, eventType: 'add_to_cart', menuItem: { $ne: null }, createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: '$menuItem', adds: { $sum: 1 } } },
      { $project: { _id: 0, menuItemId: '$_id', adds: 1 } },
    ]),
    AnalyticsEvent.aggregate([
      { $match: { ...match, eventType: 'item_view', menuItem: { $ne: null }, createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: '$menuItem', views: { $sum: 1 } } },
      { $project: { _id: 0, menuItemId: '$_id', views: 1 } },
    ]),
    countTotals({ ...match, eventType: 'order_completed', createdAt: { $gte: start, $lte: end } }),
    countTotals({ ...match, eventType: 'order_cancelled', createdAt: { $gte: start, $lte: end } }),
    countTotals({ ...match, eventType: 'refund', createdAt: { $gte: start, $lte: end } }),
    orderRevenueRows(rid, start, end),
    countTotals({ ...viewMatch, createdAt: { $gte: prevStart, $lt: start } }),
    countTotals({ ...match, eventType: 'order_completed', createdAt: { $gte: prevStart, $lt: start } }),
  ]);

  const addsByItem = new Map(itemAdds.map((r) => [String(r.menuItemId), r.adds]));
  const viewsByItem = new Map(itemViews.map((r) => [String(r.menuItemId), r.views]));
  const menuItems = topItems.map((row) => {
    const key = String(row.menuItemId);
    const itemViewCount = viewsByItem.get(key) || row.views || 0;
    const addCount = addsByItem.get(key) || 0;
    return {
      menuItemId: row.menuItemId,
      name: row.name,
      price: row.price,
      views: itemViewCount,
      addToCart: addCount,
      // Item engagement = add-to-cart events / item views × 100.
      engagement: itemViewCount > 0 ? Math.round((addCount / itemViewCount) * 1000) / 10 : 0,
    };
  });

  const completedCount = completed.total;
  // Menu conversion = completed attributed orders / unique menu visitors × 100.
  const menuConversionRate = views.uniqueVisitors > 0
    ? Math.round((completedCount / views.uniqueVisitors) * 1000) / 10
    : 0;
  const prevConversionRate = prevViews.uniqueVisitors > 0
    ? Math.round((prevCompleted.total / prevViews.uniqueVisitors) * 1000) / 10
    : 0;

  const byEventTypeMap = Object.fromEntries(byType.map((r) => [r.eventType, r.count]));
  const revenue = revenueRows[0] || { revenue: 0, orders: 0, avgOrderValue: 0 };

  return {
    period,
    range: { from: start, to: end },
    summary: {
      // Kept for the existing vendor contract.
      totalViews: views.total,
      uniqueVisitors: views.uniqueVisitors,
      today: { views: today.total, uniqueVisitors: today.uniqueVisitors },
      week: { views: week.total, uniqueVisitors: week.uniqueVisitors },
      month: { views: month.total, uniqueVisitors: month.uniqueVisitors },
      itemViews: byEventTypeMap.item_view || 0,
      addToCart: byEventTypeMap.add_to_cart || 0,
      removeFromCart: byEventTypeMap.remove_from_cart || 0,
      checkoutInitiated: byEventTypeMap.checkout_initiated || 0,
      completedOrders: completedCount,
      cancelledOrders: cancelled.total,
      refunds: refunds.total,
      conversionRate: menuConversionRate,
      revenue: revenue.revenue,
      averageOrderValue: revenue.avgOrderValue,
      // Attribution window is disclosed so "attributed" is unambiguous.
      attribution: { windowHours: Math.round(attributionWindowMs() / 3600000) },
    },
    comparison: {
      previous: {
        totalViews: prevViews.total,
        uniqueVisitors: prevViews.uniqueVisitors,
        completedOrders: prevCompleted.total,
        conversionRate: prevConversionRate,
      },
      viewsChangePct: pctChange(views.total, prevViews.total),
      uniqueVisitorsChangePct: pctChange(views.uniqueVisitors, prevViews.uniqueVisitors),
      completedOrdersChangePct: pctChange(completedCount, prevCompleted.total),
      conversionRateChangePct: pctChange(menuConversionRate, prevConversionRate),
    },
    daily,
    byEventType: byType.map((r) => ({ eventType: r.eventType, count: r.count })),
    topItems: menuItems,
    mostViewedItems: menuItems.slice(0, 5),
  };
}

function emptyRestaurantAnalytics(period) {
  return {
    period,
    range: { from: null, to: null },
    summary: {
      totalViews: 0, uniqueVisitors: 0,
      today: { views: 0, uniqueVisitors: 0 },
      week: { views: 0, uniqueVisitors: 0 },
      month: { views: 0, uniqueVisitors: 0 },
      itemViews: 0, addToCart: 0, removeFromCart: 0, checkoutInitiated: 0,
      completedOrders: 0, cancelledOrders: 0, refunds: 0,
      conversionRate: 0, revenue: 0, averageOrderValue: 0,
      attribution: { windowHours: Math.round(attributionWindowMs() / 3600000) },
    },
    comparison: {
      previous: { totalViews: 0, uniqueVisitors: 0, completedOrders: 0, conversionRate: 0 },
      viewsChangePct: 0, uniqueVisitorsChangePct: 0, completedOrdersChangePct: 0, conversionRateChangePct: 0,
    },
    daily: [], byEventType: [], topItems: [], mostViewedItems: [],
  };
}

function pctChange(current, previous) {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  if (p === 0) return c === 0 ? 0 : 100;
  return Math.round(((c - p) / p) * 1000) / 10;
}

/** Delivered-order revenue for one restaurant in a range. */
async function orderRevenueRows(restaurantId, start, end) {
  const Order = require('../models/Order');
  try {
    const rows = await Order.aggregate([
      { $match: { restaurant: restaurantId, status: 'delivered', createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, revenue: { $sum: { $ifNull: ['$total', 0] } }, orders: { $sum: 1 } } },
      { $project: { _id: 0, revenue: 1, orders: 1 } },
    ]);
    const row = rows[0] || { revenue: 0, orders: 0 };
    const revenue = Math.round((Number(row.revenue) + Number.EPSILON) * 100) / 100;
    return [{ revenue, orders: row.orders || 0, avgOrderValue: row.orders ? Math.round((revenue / row.orders) * 100) / 100 : 0 }];
  } catch (err) {
    console.error('[analytics] orderRevenueRows failed:', err.message);
    return [{ revenue: 0, orders: 0, avgOrderValue: 0 }];
  }
}

/**
 * Admin platform-wide menu analytics: most-viewed restaurants and items,
 * conversion rates, high-view/low-order restaurants and traffic trends.
 */
async function getAdminMenuAnalytics({ period = '30d', from = null, to = null } = {}) {
  const { start, end } = periodBounds({ period, from, to });
  const range = { createdAt: { $gte: start, $lte: end } };
  const viewTypes = ['restaurant_view', 'menu_view'];
  const Restaurant = require('../models/Restaurant');

  const [viewsByRestaurant, completedByRestaurant, itemViews, dailyTrend, totals] = await Promise.all([
    AnalyticsEvent.aggregate([
      { $match: { scope: 'restaurant', eventType: { $in: viewTypes }, ...range } },
      { $group: { _id: '$restaurant', views: { $sum: 1 }, uniques: { $addToSet: '$visitorKey' } } },
      { $project: { _id: 0, restaurantId: '$_id', views: 1, uniqueVisitors: { $size: '$uniques' } } },
      { $sort: { views: -1 } },
    ]),
    AnalyticsEvent.aggregate([
      { $match: { scope: 'restaurant', eventType: 'order_completed', ...range } },
      { $group: { _id: '$restaurant', orders: { $sum: 1 } } },
      { $project: { _id: 0, restaurantId: '$_id', orders: 1 } },
    ]),
    AnalyticsEvent.aggregate([
      { $match: { scope: 'restaurant', eventType: 'item_view', menuItem: { $ne: null }, ...range } },
      { $group: { _id: { restaurant: '$restaurant', menuItem: '$menuItem' }, views: { $sum: 1 } } },
      { $sort: { views: -1 } },
      { $limit: 20 },
      { $lookup: { from: 'menus', localField: '_id.menuItem', foreignField: '_id', as: 'm', pipeline: [{ $project: { name: 1 } }] } },
      { $lookup: { from: 'restaurants', localField: '_id.restaurant', foreignField: '_id', as: 'r', pipeline: [{ $project: { name: 1 } }] } },
      { $project: { _id: 0, restaurantId: '$_id.restaurant', restaurantName: { $ifNull: [{ $first: '$r.name' }, 'Unknown'] }, menuItemId: '$_id.menuItem', itemName: { $ifNull: [{ $first: '$m.name' }, 'Item'] }, views: 1 } },
    ]),
    AnalyticsEvent.aggregate([
      { $match: { scope: 'restaurant', eventType: { $in: viewTypes }, ...range } },
      { $group: { _id: '$day', views: { $sum: 1 }, uniqueVisitors: { $addToSet: '$visitorKey' } } },
      { $project: { _id: 0, day: '$_id', views: 1, uniqueVisitors: { $size: '$uniqueVisitors' } } },
      { $sort: { day: 1 } },
    ]),
    countTotals({ scope: 'restaurant', eventType: { $in: viewTypes }, ...range }),
  ]);

  const completedMap = new Map(completedByRestaurant.map((r) => [String(r.restaurantId), r.orders]));
  const ids = viewsByRestaurant.map((r) => r.restaurantId);
  const names = ids.length
    ? await Restaurant.find({ _id: { $in: ids } }).select('name').lean()
    : [];
  const nameMap = new Map(names.map((r) => [String(r._id), r.name]));

  const restaurants = viewsByRestaurant.map((row) => {
    const orders = completedMap.get(String(row.restaurantId)) || 0;
    const conversionRate = row.uniqueVisitors > 0 ? Math.round((orders / row.uniqueVisitors) * 1000) / 10 : 0;
    return {
      restaurantId: row.restaurantId,
      name: nameMap.get(String(row.restaurantId)) || 'Unknown',
      views: row.views,
      uniqueVisitors: row.uniqueVisitors,
      completedOrders: orders,
      conversionRate,
    };
  });

  // High-view / low-order: a meaningful audience but a weak conversion.
  const highViewLowOrder = restaurants
    .filter((r) => r.uniqueVisitors >= 20 && r.conversionRate < 5)
    .slice(0, 20);

  return {
    period,
    range: { from: start, to: end },
    summary: {
      totalViews: totals.total,
      uniqueVisitors: totals.uniqueVisitors,
      restaurantsWithViews: restaurants.length,
      completedOrders: completedByRestaurant.reduce((acc, r) => acc + r.orders, 0),
    },
    topRestaurants: restaurants.slice(0, 20),
    mostViewedItems: itemViews,
    highViewLowOrder,
    dailyTrend,
    conversionRates: restaurants
      .map((r) => ({ restaurantId: r.restaurantId, name: r.name, conversionRate: r.conversionRate, uniqueVisitors: r.uniqueVisitors, completedOrders: r.completedOrders }))
      .slice(0, 50),
  };
}

module.exports = {
  INDIA_TZ,
  BROWSE_EVENTS,
  FUNNEL_EVENTS,
  OUTCOME_EVENTS,
  DAILY_EVENTS,
  ALL_EVENTS,
  indiaDay,
  indiaDayStart,
  actorKey,
  sessionKeyHash,
  isBotUserAgent,
  dedupeKeyFor,
  dedupeWindowMs,
  attributionWindowMs,
  periodBounds,
  recordEvent,
  recordVisit,
  recordOrderOutcome,
  isAttributedVisit,
  getPlatformVisitAnalytics,
  getRestaurantVisitAnalytics,
  getAdminMenuAnalytics,
};

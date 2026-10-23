'use strict';

// ─────────────────────────────────────────────────────────────────────
// Visit analytics service (Pillar 8).
//
// recordVisit() is fire-and-forget and never throws: a tracking failure must
// never break a page load or a checkout. Aggregation helpers are read-only.
//
// Uniques: the dedupeKey is (event, actor|visitorKey, restaurant, day), and the
// unique index makes the insert idempotent — a refresh loop still writes one
// row, so "unique visitors per day" is exact without any in-memory state.
// ─────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const AnalyticsEvent = require('../models/AnalyticsEvent');

const INDIA_TZ = 'Asia/Kolkata';

/** YYYY-MM-DD for the given instant in India Standard Time. */
function indiaDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: INDIA_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/** Best-effort actor key. Logged-in users use their id; guests a hashed fingerprint. */
function actorKey({ userId = null, ip = '', userAgent = '' } = {}) {
  if (userId) return `u:${userId}`;
  const salt = String(process.env.ANALYTICS_VISITOR_SALT || 'eatswada-visitor');
  const hash = crypto.createHash('sha256').update(`${salt}|${ip}|${userAgent}`).digest('hex').slice(0, 24);
  return `g:${hash}`;
}

function dedupeKeyFor({ eventType, restaurantId = null, actor, day }) {
  return `${eventType}:${restaurantId || 'platform'}:${actor}:${day}`;
}

/**
 * Record one visit event. Idempotent per actor/day. Returns { recorded } and
 * never rejects.
 */
async function recordVisit({ eventType, scope, restaurantId = null, userId = null, ip = '', userAgent = '', platform = '', referrer = '' } = {}) {
  try {
    if (!eventType) return { recorded: false };
    const day = indiaDay();
    const actor = actorKey({ userId, ip, userAgent });
    const resolvedScope = scope || (restaurantId ? 'restaurant' : 'platform');
    const dedupeKey = dedupeKeyFor({ eventType, restaurantId, actor, day });
    await AnalyticsEvent.updateOne(
      { dedupeKey },
      {
        $setOnInsert: {
          scope: resolvedScope,
          eventType,
          restaurant: restaurantId || null,
          user: userId || null,
          visitorKey: actor,
          day,
          dedupeKey,
          platform: String(platform || '').slice(0, 40),
          referrer: String(referrer || '').slice(0, 200),
        },
      },
      { upsert: true }
    );
    return { recorded: true };
  } catch (err) {
    // Duplicate key = already counted today. Anything else is logged and ignored.
    if (err?.code !== 11000) console.error('[analytics] recordVisit failed:', err.message);
    return { recorded: false };
  }
}

function daysAgo(n) {
  return new Date(Date.now() - Math.max(0, Number(n) || 0) * 86400000);
}

/** Platform-scope traffic: totals, uniques, daily series and top restaurants. */
async function getPlatformVisitAnalytics({ period = '30d' } = {}) {
  const days = period === '7d' ? 7 : period === '90d' ? 90 : period === 'all' ? 3650 : 30;
  const since = daysAgo(days);

  const [totals, daily, topRestaurants] = await Promise.all([
    AnalyticsEvent.aggregate([
      { $match: { scope: 'platform', createdAt: { $gte: since } } },
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
      { $match: { scope: 'platform', createdAt: { $gte: since } } },
      {
        $group: {
          _id: '$day',
          visits: { $sum: 1 },
          uniqueVisitors: { $addToSet: '$visitorKey' },
        },
      },
      { $project: { _id: 0, day: '$_id', visits: 1, uniqueVisitors: { $size: '$uniqueVisitors' } } },
      { $sort: { day: 1 } },
    ]),
    AnalyticsEvent.aggregate([
      { $match: { scope: 'restaurant', eventType: { $in: ['restaurant_view', 'menu_view'] }, createdAt: { $gte: since } } },
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

/** Restaurant-scope traffic for one restaurant (vendor dashboard). */
async function getRestaurantVisitAnalytics(restaurantId, { period = '30d' } = {}) {
  const days = period === '7d' ? 7 : period === '90d' ? 90 : period === 'all' ? 3650 : 30;
  const since = daysAgo(days);
  const match = { scope: 'restaurant', restaurant: restaurantId, createdAt: { $gte: since } };

  const [totals, daily, byType] = await Promise.all([
    AnalyticsEvent.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalViews: { $sum: 1 },
          uniqueVisitors: { $addToSet: '$visitorKey' },
        },
      },
      { $project: { _id: 0, totalViews: 1, uniqueVisitors: { $size: '$uniqueVisitors' } } },
    ]),
    AnalyticsEvent.aggregate([
      { $match: match },
      { $group: { _id: '$day', views: { $sum: 1 }, uniqueVisitors: { $addToSet: '$visitorKey' } } },
      { $project: { _id: 0, day: '$_id', views: 1, uniqueVisitors: { $size: '$uniqueVisitors' } } },
      { $sort: { day: 1 } },
    ]),
    AnalyticsEvent.aggregate([
      { $match: match },
      { $group: { _id: '$eventType', count: { $sum: 1 } } },
      { $project: { _id: 0, eventType: '$_id', count: 1 } },
    ]),
  ]);

  const t = totals[0] || { totalViews: 0, uniqueVisitors: 0 };
  return {
    period,
    summary: { totalViews: t.totalViews || 0, uniqueVisitors: t.uniqueVisitors || 0 },
    daily,
    byEventType: byType,
  };
}

module.exports = {
  INDIA_TZ,
  indiaDay,
  actorKey,
  dedupeKeyFor,
  recordVisit,
  getPlatformVisitAnalytics,
  getRestaurantVisitAnalytics,
};

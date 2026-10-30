'use strict';

const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────────────
// Visit / traffic / funnel analytics (Pillar 8, extended).
//
// AUDIT NOTE (menu-view tracking fix):
// The original collection only carried site/restaurant/menu views, deduped
// per actor per CALENDAR DAY. That made "total menu views" indistinguishable
// from "unique daily visitors" — a customer who opened a menu five times in
// one day produced one row, so vendors saw a flat, meaningless number and
// "today's views" never moved. It also could not express the rest of the
// funnel (item views, add-to-cart, checkout, completed/cancelled orders).
//
// This schema is ADDITIVE: every pre-existing field keeps its meaning, so the
// existing rollups and tests still work. What changed:
//   • eventType now covers the whole funnel, not just browse events.
//   • dedupeKey is built over a CONFIGURABLE time bucket instead of a day, so
//     a refresh loop still writes one row but a genuine return visit later in
//     the day is counted again (that is what makes "total views" real).
//   • menuItem / order / sessionKey / eventKey / attributed were added for
//     per-item engagement, order attribution and idempotent ingestion.
//
// Deliberately small and append-only. Uniques are exact via $addToSet on
// visitorKey; totals are exact via the row count.
// ─────────────────────────────────────────────────────────────────────

const EVENT_TYPES = [
  // Browse / traffic
  'site_visit',
  'restaurant_view',
  'menu_view',
  'search',
  // Funnel
  'item_view',
  'add_to_cart',
  'remove_from_cart',
  'checkout_initiated',
  // Outcomes (server-authoritative)
  'order_completed',
  'order_cancelled',
  'refund',
];

const analyticsEventSchema = new mongoose.Schema({
  // 'platform' for site-wide page views; 'restaurant' for a restaurant/menu view.
  scope: { type: String, enum: ['platform', 'restaurant'], required: true, index: true },
  eventType: { type: String, enum: EVENT_TYPES, required: true },
  // The restaurant whose menu was viewed (null for platform-scope events).
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', default: null, index: true },
  // Menu item for item_view / add_to_cart / remove_from_cart. Validated to
  // belong to `restaurant` before the row is written.
  menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'Menu', default: null },
  // Order for the outcome events. Unique per order so one order can never be
  // counted twice (idempotent order outcomes).
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  // Logged-in visitor. Null for guests.
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Server-derived, non-reversible visitor key (hashed) so guests can be counted
  // as uniques without storing an IP address.
  visitorKey: { type: String, default: '', index: true },
  // Hashed browser session key (never the raw session id) used for the
  // configurable view-dedupe window. Absent for server-side outcome events.
  sessionKey: { type: String, default: '' },
  // Client-supplied idempotency id. When present it is folded into dedupeKey so
  // a retried beacon can never double-count.
  eventKey: { type: String, default: '' },
  // Day bucket in Asia/Kolkata (YYYY-MM-DD) — kept for the existing daily rollups.
  day: { type: String, required: true, index: true },
  // Time bucket (epoch ms / window) used by the dedupe key.
  bucket: { type: Number, default: 0 },
  // Per-event dedupe key: one row per (event, actor|session, subject, bucket).
  dedupeKey: { type: String, required: true, unique: true },
  // Coarse client hints — never an address, never a full user agent.
  platform: { type: String, default: '', maxlength: 40 },
  referrer: { type: String, default: '', maxlength: 200 },
  // Event source: web | android | ios | server. Server for outcome events.
  source: { type: String, default: 'web', maxlength: 20 },
  // Attributed orders only: the customer demonstrably opened this restaurant's
  // menu inside the attribution window before ordering. Orders that merely
  // happen to be placed by a previous visitor stay false.
  attributed: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now, index: true },
}, { timestamps: false });

// Daily rollups: platform scope over time, and per-restaurant over time.
analyticsEventSchema.index({ scope: 1, eventType: 1, day: 1 });
analyticsEventSchema.index({ restaurant: 1, eventType: 1, day: 1 });
// Menu-view / funnel reporting reads (restaurant + type) over a date range.
analyticsEventSchema.index({ restaurant: 1, eventType: 1, createdAt: -1 });
// Per-item engagement: item views vs add-to-cart.
analyticsEventSchema.index({ restaurant: 1, menuItem: 1, eventType: 1 });
// Attribution lookups: "did this visitor view this restaurant recently?".
analyticsEventSchema.index({ restaurant: 1, visitorKey: 1, eventType: 1, createdAt: -1 });
// Admin "most viewed" across every restaurant.
analyticsEventSchema.index({ eventType: 1, createdAt: -1 });
// One outcome row per (order, outcome type), enforced by the database (partial:
// only rows that actually carry an order). Idempotent order outcomes regardless
// of bucket, while still allowing a later refund row for a completed order.
analyticsEventSchema.index(
  { order: 1, eventType: 1 },
  { unique: true, partialFilterExpression: { order: { $type: 'objectId' } } }
);

module.exports = mongoose.models.AnalyticsEvent || mongoose.model('AnalyticsEvent', analyticsEventSchema);
module.exports.EVENT_TYPES = EVENT_TYPES;

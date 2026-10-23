'use strict';

const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────────────
// Visit / traffic analytics (Pillar 8).
//
// The admin could already see WHO logs in, but not HOW MANY people browse the
// customer site — and vendors could not see how many customers opened their
// restaurant menu (a Zomato-style "views" metric). This collection records one
// row per meaningful, low-volume browse event, deduplicated per actor per day,
// so counts stay cheap to aggregate and cannot be inflated by a refresh loop.
//
// Deliberately small and append-only. The unique dedupeKey is what makes
// "unique visitor per day" exact without any application-side state.
// ─────────────────────────────────────────────────────────────────────

const analyticsEventSchema = new mongoose.Schema({
  // 'platform' for site-wide page views; 'restaurant' for a restaurant/menu view.
  scope: { type: String, enum: ['platform', 'restaurant'], required: true, index: true },
  eventType: {
    type: String,
    enum: ['site_visit', 'restaurant_view', 'menu_view', 'search'],
    required: true,
  },
  // The restaurant whose menu was viewed (null for platform-scope events).
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', default: null, index: true },
  // Logged-in visitor. Null for guests.
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Server-derived, non-reversible visitor key (hashed) so guests can be counted
  // as uniques without storing an IP address.
  visitorKey: { type: String, default: '', index: true },
  // Day bucket in Asia/Kolkata (YYYY-MM-DD), so daily uniques are a simple group.
  day: { type: String, required: true, index: true },
  // Per-event dedupe key: one row per (event, actor, restaurant, day).
  dedupeKey: { type: String, required: true, unique: true },
  // Coarse client hints — never an address, never a full user agent.
  platform: { type: String, default: '', maxlength: 40 },
  referrer: { type: String, default: '', maxlength: 200 },
  createdAt: { type: Date, default: Date.now, index: true },
}, { timestamps: false });

// Daily rollups: platform scope over time, and per-restaurant over time.
analyticsEventSchema.index({ scope: 1, eventType: 1, day: 1 });
analyticsEventSchema.index({ restaurant: 1, eventType: 1, day: 1 });

module.exports = mongoose.models.AnalyticsEvent || mongoose.model('AnalyticsEvent', analyticsEventSchema);

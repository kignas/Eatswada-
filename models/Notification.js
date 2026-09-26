'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, default: 'order' },
  title: { type: String, required: true, maxlength: 120 },
  message: { type: String, required: true, maxlength: 500 },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  readAt: { type: Date, default: null },

  // Persistent coordination state for notification rings. This lives in MongoDB
  // so multiple backend instances can safely share the same ring worker.
  dedupeKey: { type: String, default: null },
  ring: {
    active: { type: Boolean, default: false },
    attempts: { type: Number, default: 0, min: 0 },
    lastSentAt: { type: Date, default: null },
    leaseUntil: { type: Date, default: null },
  },
}, { timestamps: true });

schema.index({ user: 1, createdAt: -1 });
schema.index({ dedupeKey: 1 }, { unique: true, sparse: true });
schema.index({ 'ring.active': 1, 'ring.leaseUntil': 1, 'ring.lastSentAt': 1 });
// PERFORMANCE: backs pushService.stopRing(), which runs on every vendor
// accept/reject (vendorController) with the filter
//   { 'data.orderId': <orderId string>, 'data.kind': 'new_order' }.
// No existing index covered that filter, so each call scanned the entire
// notifications collection (which grows by several rows per order). The
// index is PARTIAL — only vendor 'new_order' ring rows are indexed (about one
// entry per order) — and the query's 'data.kind' equality makes it eligible.
schema.index(
  { 'data.orderId': 1 },
  { name: 'data.orderId_1_kind_new_order', partialFilterExpression: { 'data.kind': 'new_order' } }
);

module.exports = mongoose.models.Notification || mongoose.model('Notification', schema);

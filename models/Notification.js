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

module.exports = mongoose.models.Notification || mongoose.model('Notification', schema);

'use strict';

const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, unique: true, index: true },
  score: { type: Number, required: true, min: 1, max: 5 },
  riderScore: { type: Number, min: 1, max: 5, default: null },
  comment: { type: String, trim: true, maxlength: 500, default: '' },
  // Per-dish ratings are tied to the immutable order item snapshot.
  itemRatings: {
    type: [{
      menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'Menu', default: null },
      itemName: { type: String, required: true, trim: true, maxlength: 160 },
      score: { type: Number, required: true, min: 1, max: 5 },
      comment: { type: String, trim: true, maxlength: 300, default: '' },
    }], default: [],
  },
  // Customer-submitted food/order evidence; URLs are validated by the upload flow.
  photos: { type: [{ type: String, trim: true, maxlength: 1000 }], default: [] },
  isVisible: { type: Boolean, default: true, index: true },
  adminNote: { type: String, trim: true, maxlength: 300, default: '' },
  vendorReply: {
    message: { type: String, trim: true, maxlength: 500, default: '' },
    repliedAt: { type: Date, default: null },
    updatedAt: { type: Date, default: null },
  },
}, { timestamps: true });

reviewSchema.index({ restaurant: 1, isVisible: 1, createdAt: -1 });
reviewSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('Review', reviewSchema);

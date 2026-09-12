'use strict';

const mongoose = require('mongoose');

/**
 * Durable audit trail for permanent restaurant deletion.
 * The Restaurant document is intentionally destroyed, so the audit stores
 * immutable snapshots needed to explain who/what was deleted later.
 */
const restaurantDeletionAuditSchema = new mongoose.Schema({
  restaurantId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true,
  },
  restaurantName: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100,
  },
  restaurantSlug: {
    type: String,
    required: true,
    trim: true,
    maxlength: 150,
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  deletedAt: {
    type: Date,
    required: true,
    default: Date.now,
    index: true,
  },
  menuItemsDeleted: { type: Number, min: 0, default: 0 },
  reviewsDeleted: { type: Number, min: 0, default: 0 },
  vendorAccountsDetached: { type: Number, min: 0, default: 0 },
  cartsCleaned: { type: Number, min: 0, default: 0 },
  favoritesCleaned: { type: Number, min: 0, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('RestaurantDeletionAudit', restaurantDeletionAuditSchema);

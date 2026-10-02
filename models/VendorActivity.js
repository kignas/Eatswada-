'use strict';
const mongoose = require('mongoose');
const vendorActivitySchema = new mongoose.Schema({
  restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  actorRole: { type: String, default: 'vendor' },
  type: { type: String, required: true, maxlength: 80 },
  message: { type: String, required: true, maxlength: 300 },
  entityType: { type: String, default: '' },
  entityId: { type: mongoose.Schema.Types.ObjectId, default: null },
}, { timestamps: true });
vendorActivitySchema.index({ restaurantId: 1, createdAt: -1 });
module.exports = mongoose.models.VendorActivity || mongoose.model('VendorActivity', vendorActivitySchema);

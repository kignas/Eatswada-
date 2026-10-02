'use strict';
const mongoose = require('mongoose');
const inventoryMovementSchema = new mongoose.Schema({
  restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
  menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'Menu', required: true, index: true },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  change: { type: Number, required: true },
  before: { type: Number, required: true, min: 0 },
  after: { type: Number, required: true, min: 0 },
  reason: { type: String, required: true, maxlength: 120 },
}, { timestamps: true });
inventoryMovementSchema.index({ restaurantId:  1, menuItemId: 1, createdAt: -1 });
module.exports = mongoose.models.InventoryMovement || mongoose.model('InventoryMovement', inventoryMovementSchema);

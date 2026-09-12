'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  city: { type: String, default: 'Maynaguri', trim: true },
  polygon: { type: { type: String, enum: ['Polygon'], default: 'Polygon' }, coordinates: { type: [[[Number]]], required: true } },
  deliveryFee: { type: Number, min: 0, default: 30 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });
schema.index({ polygon: '2dsphere' });
module.exports = mongoose.models.DeliveryZone || mongoose.model('DeliveryZone', schema);

'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');

const supportMessageSchema = new mongoose.Schema({
  senderRole: { type: String, enum: ['vendor', 'admin', 'system'], required: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  message: { type: String, required: true, trim: true, maxlength: 2000 },
  at: { type: Date, default: Date.now },
}, { _id: false });

const supportTicketSchema = new mongoose.Schema({
  ticketNumber: { type: String, unique: true, index: true },
  vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
  category: { type: String, enum: ['payment', 'order', 'delivery', 'customer_complaint', 'technical', 'account', 'document', 'policy', 'other'], default: 'other' },
  priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
  subject: { type: String, required: true, trim: true, maxlength: 160 },
  status: { type: String, enum: ['open', 'waiting_vendor', 'waiting_admin', 'resolved', 'closed'], default: 'open', index: true },
  messages: { type: [supportMessageSchema], default: [] },
  closedAt: { type: Date, default: null },
}, { timestamps: true });

supportTicketSchema.pre('validate', function(next) {
  if (!this.ticketNumber) {
    this.ticketNumber = `EW-T-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  }
  next();
});

supportTicketSchema.index({ vendor: 1, createdAt: -1 });

module.exports = mongoose.models.SupportTicket || mongoose.model('SupportTicket', supportTicketSchema);

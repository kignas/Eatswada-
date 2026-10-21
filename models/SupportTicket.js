'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');

const supportMessageSchema = new mongoose.Schema({
  senderRole: { type: String, enum: ['user', 'vendor', 'admin', 'system'], required: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  message: { type: String, required: true, trim: true, maxlength: 2000 },
  attachments: { type: [{ type: String, maxlength: 1000 }], default: [] },
  at: { type: Date, default: Date.now },
}, { _id: false });

const supportTicketSchema = new mongoose.Schema({
  ticketNumber: { type: String, unique: true },
  // Vendor tickets use vendor + restaurant; customer tickets use customer.
  vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', default: null, index: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
  category: { type: String, enum: ['payment', 'order', 'delivery', 'customer_complaint', 'missing_item', 'wrong_item', 'food_quality', 'spilled_order', 'late_order', 'refund', 'technical', 'account', 'document', 'policy', 'other'], default: 'other' },
  priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
  subject: { type: String, required: true, trim: true, maxlength: 160 },
  status: { type: String, enum: ['open', 'waiting_vendor', 'waiting_admin', 'waiting_customer', 'resolved', 'closed'], default: 'open', index: true },
  messages: { type: [supportMessageSchema], default: [] },
  // Complaint evidence visible to authorized ticket participants and admins.
  photos: { type: [{ type: String, trim: true, maxlength: 1000 }], default: [] },
  closedAt: { type: Date, default: null },
  // Customer chat extras. affectedItems = item names the customer picked for
  // missing/wrong-item issues. customerLastReadAt drives the unread badge.
  affectedItems: { type: [{ type: String, maxlength: 80 }], default: [] },
  customerLastReadAt: { type: Date, default: null },
  customerRating: { type: Number, min: 1, max: 5, default: null },
  customerFeedback: { type: String, trim: true, maxlength: 500, default: '' },
}, { timestamps: true });

supportTicketSchema.pre('validate', function(next) {
  if (this.customer && !this.vendor) {
    if (!this.customer) this.invalidate('customer', 'Customer is required.');
  } else if (!this.vendor || !this.restaurant) {
    this.invalidate('vendor', 'Vendor and restaurant are required for vendor tickets.');
    if (!this.restaurant) this.invalidate('restaurant', 'Restaurant is required for vendor tickets.');
  }
  if (!this.ticketNumber) {
    this.ticketNumber = `EW-T-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  }
  next();
});

supportTicketSchema.index({ vendor: 1, createdAt: -1 });
supportTicketSchema.index({ customer: 1, createdAt: -1 });
// Duplicate-open-ticket lookup in createTicket.
supportTicketSchema.index({ customer: 1, order: 1, category: 1, status: 1 });
// Admin inbox: filter by status/priority, newest activity first.
supportTicketSchema.index({ status: 1, priority: 1, updatedAt: -1 });

module.exports = mongoose.models.SupportTicket || mongoose.model('SupportTicket', supportTicketSchema);

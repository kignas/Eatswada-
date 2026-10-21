'use strict';
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const SupportTicket = require('../models/SupportTicket');
const Order = require('../models/Order');
const User = require('../models/User');
const { createNotification } = require('../services/notificationService');
const { MAX_MESSAGES, REOPEN_MS, cleanAttachments, publicTicket, hasUnread } = require('../utils/supportHelpers');

// Issues that only make sense for a specific order.
const ORDER_CATEGORIES = new Set(['missing_item', 'wrong_item', 'food_quality', 'spilled_order', 'late_order', 'delivery', 'order']);
// Issues a customer can raise with or without an order.
const GENERAL_CATEGORIES = new Set(['payment', 'refund', 'technical', 'account', 'policy', 'other']);
const HIGH_PRIORITY = new Set(['late_order', 'missing_item', 'wrong_item', 'spilled_order']);
// A ticket in any of these states is "still being worked on" — a new request in
// the same category continues it instead of opening a duplicate.
const OPEN_STATES = ['open', 'waiting_admin', 'waiting_vendor', 'waiting_customer'];

const idOk = (id) => mongoose.isValidObjectId(id);
const sizeUnderCap = { $expr: { $lt: [{ $size: '$messages' }, MAX_MESSAGES] } };

function cleanItems(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 10).map(v => String(v == null ? '' : v).trim().slice(0, 80)).filter(Boolean);
}

// Tell every admin a ticket needs attention. Best-effort: never blocks the request.
async function notifyAdmins(ticket, orderId) {
  try {
    const admins = await User.find({ role: 'admin' }).select('_id').limit(20).lean();
    await Promise.all(admins.map(a => Promise.resolve(createNotification({
      user: a._id,
      type: 'support',
      title: 'New support ticket',
      message: `${ticket.ticketNumber}: ${ticket.subject}`.slice(0, 180),
      data: { ticketId: String(ticket._id), ticketNumber: ticket.ticketNumber, orderId: orderId ? String(orderId) : '' },
    })).catch(() => {})));
  } catch (_) { /* notification failure must not fail the ticket */ }
}

exports.createTicket = asyncHandler(async (req, res) => {
  const orderIdRaw = String(req.body?.orderId || '').trim();
  const category = String(req.body?.category || 'other').trim();
  const subject = String(req.body?.subject || '').trim().slice(0, 160);
  const message = String(req.body?.message || '').trim();
  const attachments = cleanAttachments(req.body?.attachments);
  const photos = cleanAttachments(req.body?.photos);
  if (Array.isArray(req.body?.photos) && req.body.photos.length > 4) return res.status(400).json({ success:false, message:'A complaint can include up to 4 photos.' });
  const affectedItems = cleanItems(req.body?.items);

  if (!ORDER_CATEGORIES.has(category) && !GENERAL_CATEGORIES.has(category)) return res.status(400).json({ success: false, message: 'Invalid support category.' });
  if (ORDER_CATEGORIES.has(category) && !orderIdRaw) return res.status(400).json({ success: false, message: 'An orderId is required for this type of issue.' });
  if (orderIdRaw && !idOk(orderIdRaw)) return res.status(400).json({ success: false, message: 'A valid orderId is required.' });
  if (!message || message.length > 2000) return res.status(400).json({ success: false, message: 'Message is required and must be 2,000 characters or fewer.' });

  let order = null;
  if (orderIdRaw) {
    order = await Order.findOne({ _id: orderIdRaw, user: req.user._id }).select('_id orderNumber status restaurant restaurantName').lean();
    if (!order) return res.status(404).json({ success: false, message: 'Order not found for this account.' });
  }

  // Same customer + order + category already open: add this message to it
  // (never drop what the customer just typed).
  const existing = await SupportTicket.findOne({ customer: req.user._id, order: order ? order._id : null, category, status: { $in: OPEN_STATES } })
    .select('_id').sort({ createdAt: -1 }).lean();
  if (existing) {
    const now = new Date();
    const updated = await SupportTicket.findOneAndUpdate(
      { _id: existing._id, customer: req.user._id, status: { $in: OPEN_STATES }, ...sizeUnderCap },
      { $push: { messages: { senderRole: 'user', sender: req.user._id, message, attachments:[...new Set([...attachments, ...photos])].slice(0,3), at: now } }, $set: { status: 'waiting_admin', customerLastReadAt: now, ...(photos.length ? { photos } : {}) } },
      { new: true }
    );
    if (!updated) return res.status(409).json({ success: false, message: 'This conversation has reached its message limit. Please start a new request.' });
    return res.status(200).json({ success: true, data: publicTicket(updated), existing: true });
  }

  const now = new Date();
  const label = order ? ` — order ${order.orderNumber || String(order._id).slice(-6)}` : '';
  const ticket = await SupportTicket.create({
    customer: req.user._id,
    order: order ? order._id : null,
    restaurant: (order && order.restaurant) || null,
    category,
    priority: HIGH_PRIORITY.has(category) ? 'high' : 'normal',
    subject: subject || `${category.replace(/_/g, ' ')}${label}`,
    status: 'open',
    affectedItems,
    photos,
    customerLastReadAt: now,
    messages: [{ senderRole: 'user', sender: req.user._id, message, attachments, at: now }],
  });

  try { await createNotification({ user: req.user._id, type: 'support', title: 'Support request created', message: `Your support request ${ticket.ticketNumber} has been created.`, data: { ticketId: String(ticket._id), ticketNumber: ticket.ticketNumber, orderId: order ? String(order._id) : '' } }); } catch (_) {}
  notifyAdmins(ticket, order && order._id); // fire-and-forget
  return res.status(201).json({ success: true, data: publicTicket(ticket) });
});

// List view: only the last message per ticket (not whole conversations).
exports.listMyTickets = asyncHandler(async (req, res) => {
  const rows = await SupportTicket.find({ customer: req.user._id })
    .select({ ticketNumber: 1, category: 1, subject: 1, status: 1, priority: 1, order: 1, restaurant: 1, createdAt: 1, updatedAt: 1, customerLastReadAt: 1, messages: { $slice: -1 } })
    .populate('order', 'orderNumber status').populate('restaurant', 'name image')
    .sort({ updatedAt: -1 }).limit(100).lean();
  const data = rows.map(t => {
    const last = (t.messages || [])[0];
    return {
      _id: t._id, ticketNumber: t.ticketNumber, category: t.category, subject: t.subject, status: t.status,
      order: t.order, restaurant: t.restaurant, createdAt: t.createdAt, updatedAt: t.updatedAt,
      unread: hasUnread(t),
      lastMessage: last ? { senderRole: last.senderRole, message: String(last.message).slice(0, 140), at: last.at } : null,
    };
  });
  res.json({ success: true, data });
});

// Cheap badge endpoint for the Orders / Help entry points.
exports.unreadCount = asyncHandler(async (req, res) => {
  const rows = await SupportTicket.find({ customer: req.user._id, status: { $ne: 'closed' } })
    .select({ customerLastReadAt: 1, messages: { $slice: -1 } }).limit(100).lean();
  res.json({ success: true, data: { unread: rows.filter(hasUnread).length } });
});

// Full conversation. Pass ?since=<ISO time of the last message you have> to
// receive only newer messages (chat polling). Opening a ticket marks it read.
exports.getMyTicket = asyncHandler(async (req, res) => {
  if (!idOk(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid ticket ID.' });
  let since = null;
  if (req.query.since) { const d = new Date(String(req.query.since)); if (!Number.isNaN(d.getTime())) since = d; }
  const ticket = await SupportTicket.findOne({ _id: req.params.id, customer: req.user._id })
    .populate('order', 'orderNumber status estimatedDelivery').populate('restaurant', 'name image').lean();
  if (!ticket) return res.status(404).json({ success: false, message: 'Support ticket not found.' });
  const out = publicTicket(ticket, { since });
  // timestamps:false so reading never bumps the ticket to the top of the admin inbox.
  SupportTicket.updateOne({ _id: ticket._id }, { $set: { customerLastReadAt: new Date() } }, { timestamps: false }).catch(() => {});
  res.json({ success: true, data: out, serverTime: new Date().toISOString() });
});

exports.replyMyTicket = asyncHandler(async (req, res) => {
  if (!idOk(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid ticket ID.' });
  const message = String(req.body?.message || '').trim();
  if (!message || message.length > 2000) return res.status(400).json({ success: false, message: 'Message is required and must be 2,000 characters or fewer.' });
  const attachments = cleanAttachments(req.body?.attachments);

  const current = await SupportTicket.findOne({ _id: req.params.id, customer: req.user._id }).select('status closedAt order ticketNumber subject').lean();
  if (!current) return res.status(404).json({ success: false, message: 'Support ticket not found.' });
  if (current.status === 'closed') return res.status(409).json({ success: false, message: 'This ticket is closed. Create a new request if you still need help.' });
  // A resolved ticket can be reopened by replying, for a limited time.
  if (current.status === 'resolved' && current.closedAt && Date.now() - new Date(current.closedAt).getTime() > REOPEN_MS) {
    return res.status(409).json({ success: false, message: 'This ticket was resolved a while ago. Create a new request if you still need help.' });
  }

  const now = new Date();
  const updated = await SupportTicket.findOneAndUpdate(
    { _id: current._id, customer: req.user._id, status: { $ne: 'closed' }, ...sizeUnderCap },
    { $push: { messages: { senderRole: 'user', sender: req.user._id, message, attachments, at: now } }, $set: { status: 'waiting_admin', closedAt: null, customerLastReadAt: now } },
    { new: true }
  );
  if (!updated) return res.status(409).json({ success: false, message: 'This conversation can no longer accept messages. Please start a new request.' });
  if (current.status === 'resolved') notifyAdmins(updated, current.order);
  res.json({ success: true, data: publicTicket(updated) });
});

// Close the conversation, optionally leaving a 1–5 rating and short feedback.
exports.closeMyTicket = asyncHandler(async (req, res) => {
  if (!idOk(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid ticket ID.' });
  const set = { status: 'closed', closedAt: new Date() };
  const rating = Number(req.body?.rating);
  if (Number.isInteger(rating) && rating >= 1 && rating <= 5) set.customerRating = rating;
  const feedback = String(req.body?.feedback || '').trim().slice(0, 500);
  if (feedback) set.customerFeedback = feedback;
  const ticket = await SupportTicket.findOneAndUpdate({ _id: req.params.id, customer: req.user._id }, { $set: set }, { new: true });
  if (!ticket) return res.status(404).json({ success: false, message: 'Support ticket not found.' });
  res.json({ success: true, data: publicTicket(ticket) });
});

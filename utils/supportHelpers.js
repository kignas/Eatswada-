'use strict';

const MAX_MESSAGES = 200;          // per ticket, keeps the document small
const MAX_ATTACHMENTS = 3;
const REOPEN_DAYS = 7;             // customer may reply to a resolved ticket this long
const REOPEN_MS = REOPEN_DAYS * 24 * 60 * 60 * 1000;

// Attachments must be https images on a trusted host (default: Cloudinary).
// Override with SUPPORT_ATTACHMENT_HOSTS=res.cloudinary.com,cdn.example.com
const ATTACHMENT_HOSTS = String(process.env.SUPPORT_ATTACHMENT_HOSTS || 'res.cloudinary.com')
  .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);

function cleanAttachments(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    if (out.length >= MAX_ATTACHMENTS) break;
    try {
      const u = new URL(String(raw).trim());
      const host = u.hostname.toLowerCase();
      if (u.protocol !== 'https:') continue;
      if (!ATTACHMENT_HOSTS.some(h => host === h || host.endsWith('.' + h))) continue;
      if (u.href.length > 1000) continue;
      out.push(u.href);
    } catch (_) { /* ignore malformed URL */ }
  }
  return out;
}

// Customers never see internal user ids (sender) of admins/vendors.
function publicMessage(m) {
  return { senderRole: m.senderRole, message: m.message, attachments: m.attachments || [], at: m.at };
}

function hasUnread(t) {
  const msgs = Array.isArray(t.messages) ? t.messages : [];
  const last = msgs[msgs.length - 1];
  if (!last || last.senderRole === 'user') return false;
  return !t.customerLastReadAt || new Date(last.at) > new Date(t.customerLastReadAt);
}

function publicTicket(ticket, { since = null } = {}) {
  const o = ticket && typeof ticket.toObject === 'function' ? ticket.toObject() : ticket;
  let msgs = Array.isArray(o.messages) ? o.messages : [];
  if (since) msgs = msgs.filter(m => new Date(m.at) > since);
  return {
    _id: o._id,
    ticketNumber: o.ticketNumber,
    category: o.category,
    priority: o.priority,
    subject: o.subject,
    status: o.status,
    order: o.order,
    restaurant: o.restaurant,
    affectedItems: o.affectedItems || [],
    customerRating: o.customerRating || null,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    closedAt: o.closedAt,
    unread: hasUnread(o),
    messages: msgs.map(publicMessage),
  };
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = { MAX_MESSAGES, MAX_ATTACHMENTS, REOPEN_MS, REOPEN_DAYS, cleanAttachments, publicMessage, publicTicket, hasUnread, escapeRegex };

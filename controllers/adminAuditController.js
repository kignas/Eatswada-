'use strict';

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/audit-logs
//
// Read-only viewer for the AdminAuditLog trail that services/auditService
// already writes on every privileged admin mutation. Until now the trail
// could be written but never read back, so the admin Audit page had nothing
// to show except pricing-rule history.
//
// Full administrators only: entries carry old/new values and request context
// (IP) that restricted staff must not browse.
//
// Query: page, limit (<=100), action (exact or prefix like "restaurant."),
//        targetType, actor (admin id), q (free text), from, to (ISO dates).
// ─────────────────────────────────────────────────────────────────────

const mongoose = require('mongoose');
const AdminAuditLog = require('../models/AdminAuditLog');
const asyncHandler = require('express-async-handler');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function clampInt(value, { min, max, fallback }) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseDate(value, endOfDay = false) {
  if (!value) return null;
  const text = String(value).trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
    : new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildFilter(query = {}) {
  const filter = {};

  const action = String(query.action || '').trim().slice(0, 120);
  if (action) {
    // "restaurant." style prefixes match a whole family of actions.
    filter.action = action.endsWith('.')
      ? { $regex: `^${escapeRegex(action)}` }
      : action;
  }

  const targetType = String(query.targetType || '').trim().slice(0, 60);
  if (targetType) filter.targetType = targetType;

  const actor = String(query.actor || '').trim();
  if (actor && mongoose.Types.ObjectId.isValid(actor)) filter.actor = actor;

  const q = String(query.q || '').trim().slice(0, 80);
  if (q) {
    const rx = { $regex: escapeRegex(q), $options: 'i' };
    filter.$or = [{ actorName: rx }, { action: rx }, { targetLabel: rx }];
  }

  const from = parseDate(query.from);
  const to = parseDate(query.to, true);
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }
  return filter;
}

function serialize(row) {
  return {
    _id: row._id,
    at: row.createdAt,
    actorId: row.actor || null,
    actorName: row.actorName || '',
    action: row.action,
    targetType: row.targetType || '',
    targetId: row.targetId || null,
    targetLabel: row.targetLabel || '',
    oldValue: row.oldValue === undefined ? null : row.oldValue,
    newValue: row.newValue === undefined ? null : row.newValue,
    ip: row.ip || '',
  };
}

const listAuditLogs = asyncHandler(async (req, res) => {
  const page = clampInt(req.query.page, { min: 1, max: 100000, fallback: 1 });
  const limit = clampInt(req.query.limit, { min: 1, max: 100, fallback: 25 });
  const filter = buildFilter(req.query);

  const [rows, total] = await Promise.all([
    AdminAuditLog.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    AdminAuditLog.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: rows.map(serialize),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  });
});

module.exports = { listAuditLogs, buildFilter, serialize };

'use strict';

// ─────────────────────────────────────────────────────────────────────
// Foundation-1.1 — audit helper.
//
// logAdminAction() is intentionally fire-and-forget-safe: it is awaited by
// callers, but it NEVER throws. If the audit write fails, it is logged to
// the server console and the caller proceeds. An audit trail must never be
// able to break the operation it is recording.
// ─────────────────────────────────────────────────────────────────────

const AdminAuditLog = require('../models/AdminAuditLog');

/**
 * Pull best-effort request context (actor, ip, user-agent) off an Express req.
 */
function contextFromReq(req) {
  const actor = req?.user?._id || req?.user?.id || null;
  const actorName = req?.user?.name || '';
  const ip =
    (req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim() ||
    req?.ip ||
    req?.socket?.remoteAddress ||
    '';
  const userAgent = req?.headers?.['user-agent'] || '';
  return { actor, actorName, ip, userAgent };
}

/**
 * Record a privileged admin action. Safe to await; resolves to the created
 * document or null on failure. Never rejects.
 *
 * @param {object} req    Express request (for actor/ip/user-agent).
 * @param {object} entry  { action, targetType, targetId, targetLabel, oldValue, newValue }
 */
async function logAdminAction(req, entry = {}) {
  try {
    const ctx = contextFromReq(req);
    if (!ctx.actor) return null; // no authenticated admin => nothing to attribute
    return await AdminAuditLog.create({
      actor: ctx.actor,
      actorName: ctx.actorName,
      action: entry.action,
      targetType: entry.targetType || '',
      targetId: entry.targetId || null,
      targetLabel: entry.targetLabel || '',
      oldValue: entry.oldValue === undefined ? null : entry.oldValue,
      newValue: entry.newValue === undefined ? null : entry.newValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  } catch (err) {
    console.error('[AUDIT] failed to record admin action:', err.message);
    return null;
  }
}

module.exports = { logAdminAction };

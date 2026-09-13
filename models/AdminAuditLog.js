'use strict';

// ─────────────────────────────────────────────────────────────────────
// Foundation-1.1 — Admin audit trail.
//
// Records privileged admin mutations (commission changes, approvals,
// deletions, refunds, permission changes, order-status overrides) with
// who / what / target / old value / new value / ip / when.
//
// This is ADDITIVE. It never blocks the underlying admin action: callers
// use services/auditService.logAdminAction(), which swallows its own
// errors so an audit-write failure can never fail a real operation.
// The existing RestaurantDeletionAudit model is left untouched.
// ─────────────────────────────────────────────────────────────────────

const mongoose = require('mongoose');

const adminAuditLogSchema = new mongoose.Schema(
  {
    // The admin who performed the action.
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    actorName: { type: String, default: '' },

    // A stable machine key, e.g. 'restaurant.commission.update'.
    action: { type: String, required: true, index: true },

    // What was acted on.
    targetType: { type: String, default: '' },   // 'restaurant' | 'order' | 'vendor' | 'rider' | 'admin' | ...
    targetId: { type: mongoose.Schema.Types.ObjectId, default: null },
    targetLabel: { type: String, default: '' },   // human-friendly (name / order number)

    // Before/after — stored loosely because shapes vary by action.
    oldValue: { type: mongoose.Schema.Types.Mixed, default: null },
    newValue: { type: mongoose.Schema.Types.Mixed, default: null },

    // Request context (best-effort).
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
  },
  { timestamps: true }
);

adminAuditLogSchema.index({ actor: 1, createdAt: -1 });
adminAuditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
adminAuditLogSchema.index({ createdAt: -1 });

module.exports =
  mongoose.models.AdminAuditLog ||
  mongoose.model('AdminAuditLog', adminAuditLogSchema);

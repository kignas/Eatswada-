'use strict';

// Admin permission policy (Phase 1, fail-closed).
//
//  * Full administrators are accounts with role === 'admin' whose stored
//    permissions array explicitly contains FULL_ACCESS ('*'). The bootstrap
//    route (POST /api/auth/setup-admin) creates the first admin this way, and
//    the one-off migration in docs/security/PHASE1_REMEDIATION_REPORT.md grants
//    it to existing legacy admins. It cannot be granted through the API.
//  * Restricted staff (role === 'admin') need at least one of the permissions
//    the route requires.
//  * An EMPTY, missing, non-array or malformed permissions value grants NOTHING.
//    (Previously an empty array was treated as full administrator, so a
//    missing/garbled value or an accidental "clear all permissions" silently
//    promoted the account to full access.)
//  * A route that names no permission cannot be satisfied by restricted staff.
const FULL_ACCESS = '*';

const isWellFormed = (permissions) =>
  Array.isArray(permissions) && permissions.every((p) => typeof p === 'string' && p.length > 0);

const isFullAdmin = (user) =>
  Boolean(user) && user.role === 'admin' && isWellFormed(user.permissions) && user.permissions.includes(FULL_ACCESS);

const deny = (res, message) => res.status(403).json({ success: false, message });

const requirePermission = (...required) => (req, res, next) => {
  const user = req.user;
  if (!user || user.role !== 'admin') return deny(res, 'Admin credentials required.');
  if (!isWellFormed(user.permissions)) return deny(res, 'You do not have permission for this action.');
  if (user.permissions.includes(FULL_ACCESS)) return next();
  if (required.length > 0 && required.some((p) => user.permissions.includes(p))) return next();
  return deny(res, 'You do not have permission for this action.');
};

// Applies a permission gate to admin callers while preserving the ownership
// checks of a route that intentionally supports another role (for example, a
// vendor editing only their own restaurant). Use only AFTER authorize(...).
const requirePermissionForAdmin = (...required) => (req, res, next) => {
  if (req.user?.role !== 'admin') return next();
  return requirePermission(...required)(req, res, next);
};

// For operations that must never be delegated to restricted staff
// (e.g. changing other admins' permissions).
const requireFullAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') return deny(res, 'Admin credentials required.');
  if (!isFullAdmin(req.user)) return deny(res, 'Full administrator access is required for this action.');
  return next();
};

module.exports = { requirePermission, requirePermissionForAdmin, requireFullAdmin, isFullAdmin, FULL_ACCESS };

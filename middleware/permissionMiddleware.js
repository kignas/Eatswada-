'use strict';

// Empty permissions preserve the existing all-powerful admin behavior.
// Populated permissions enable least-privilege admin staff accounts.
const requirePermission = (...required) => (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin credentials required.' });
  }
  const permissions = Array.isArray(req.user.permissions) ? req.user.permissions : [];
  if (permissions.length === 0 || required.some(p => permissions.includes(p))) return next();
  return res.status(403).json({ success: false, message: 'You do not have permission for this action.' });
};
module.exports = { requirePermission };

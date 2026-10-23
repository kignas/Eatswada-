'use strict';

// ─────────────────────────────────────────────────────────────────────
// Customer trust / COD penalty service (Pillar 3 + Pillar 7).
//
// Records the two real-world COD abuses the platform cares about:
//   • a customer refuses a COD delivery at the door (food wasted, rider paid)
//   • a delivery fails through customer fault (unreachable / unavailable)
//
// Each event increments a counter on the customer. When the platform enables
// automatic blocking and a customer crosses the configured limit, their COD
// is blocked (isCodBlocked) and the event is stamped as auto-blocked, so the
// decision is auditable and reversible from the admin console.
//
// This module never throws into a request path: trust accounting must not be
// able to break a delivery transition.
// ─────────────────────────────────────────────────────────────────────

const User = require('../models/User');
const { getPlatformSettings } = require('./platformSettingsService');
const { shouldAutoBlockCod } = require('./codPolicyService');

// Delivery-issue reasons that represent a customer-fault COD failure.
const CUSTOMER_FAULT_REASONS = new Set(['customer_unreachable', 'customer_unavailable', 'customer_requested_cancel']);

function isCustomerFaultReason(reasonCode) {
  return CUSTOMER_FAULT_REASONS.has(String(reasonCode || ''));
}

/**
 * Record one COD failure for a customer.
 *
 * @param {string}  userId
 * @param {object}  args
 * @param {'refused'|'failed'} args.kind   refused = declined at door; failed = undeliverable
 * @param {string}  args.reasonCode        rider delivery-issue reason (optional)
 * @param {object}  args.settings          pre-loaded platform settings (optional)
 * @returns {Promise<{ recorded: boolean, autoBlocked: boolean, counters?: object }>}
 */
async function recordCodFailure(userId, { kind = 'failed', reasonCode = '', settings = null } = {}) {
  if (!userId) return { recorded: false, autoBlocked: false };
  try {
    const user = await User.findById(userId).select('isCodBlocked codTrust');
    if (!user) return { recorded: false, autoBlocked: false };

    user.codTrust = user.codTrust || {};
    if (kind === 'refused') {
      user.codTrust.refusedDeliveries = Number(user.codTrust.refusedDeliveries || 0) + 1;
    } else {
      user.codTrust.failedDeliveries = Number(user.codTrust.failedDeliveries || 0) + 1;
    }
    user.codTrust.lastFailedAt = new Date();
    user.codTrust.lastReasonCode = String(reasonCode || '').slice(0, 60);

    let autoBlocked = false;
    const resolved = settings || await getPlatformSettings();
    if (user.isCodBlocked !== true && shouldAutoBlockCod(user.codTrust, resolved)) {
      user.isCodBlocked = true;
      user.codTrust.autoBlocked = true;
      user.codTrust.autoBlockedAt = new Date();
      autoBlocked = true;
    }
    await user.save();
    return {
      recorded: true,
      autoBlocked,
      counters: {
        refusedDeliveries: Number(user.codTrust.refusedDeliveries || 0),
        failedDeliveries: Number(user.codTrust.failedDeliveries || 0),
      },
    };
  } catch (err) {
    console.error('[trust] recordCodFailure failed:', err.message);
    return { recorded: false, autoBlocked: false };
  }
}

/**
 * Freeze or unfreeze a customer account. A frozen customer cannot place new
 * orders (enforced in orderController.createOrder). Never throws.
 */
async function setAccountFreeze(userId, { frozen, reason = '', adminId = null } = {}) {
  const user = await User.findById(userId).select('role accountStatus');
  if (!user) return { ok: false, status: 404, message: 'Customer not found.' };
  if (user.role !== 'user') return { ok: false, status: 400, message: 'Only customer accounts can be frozen.' };

  user.accountStatus = frozen ? 'frozen' : 'active';
  user.frozenReason = frozen ? String(reason || '').slice(0, 300) : '';
  user.frozenAt = frozen ? new Date() : null;
  user.frozenBy = frozen ? adminId : null;
  await user.save();
  return { ok: true, data: { userId: user._id, accountStatus: user.accountStatus, frozenReason: user.frozenReason, frozenAt: user.frozenAt } };
}

module.exports = { CUSTOMER_FAULT_REASONS, isCustomerFaultReason, recordCodFailure, setAccountFreeze };

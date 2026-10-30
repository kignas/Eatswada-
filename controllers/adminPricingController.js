'use strict';

// ─────────────────────────────────────────────────────────────────────
// Admin pricing controller — the "Admin -> Financial Management -> Dynamic
// Pricing" surface.
//
// Reads and writes the dynamic-pricing rule set. Writes are:
//   • permission-gated (finance.manage) at the route layer;
//   • validated and coerced (malformed values are rejected, never stored);
//   • AUDITED with the acting user, timestamp and old/new value for every
//     changed key, through the existing services/auditService.
//
// Nothing here touches payment credentials or production configuration. All
// keys are additive over ENGINE_DEFAULTS, so an un-migrated deployment keeps
// behaving exactly as before.
// ─────────────────────────────────────────────────────────────────────

const asyncHandler = require('express-async-handler');

const PricingRule = require('../models/PricingRule');
const OrderFinancialSnapshot = require('../models/OrderFinancialSnapshot');
const { ENGINE_DEFAULTS, OVERRIDABLE_KEYS, resolvePricingRules, mergeRules, versionOf } = require('../services/pricing/pricingRules');
const { logAdminAction } = require('../services/auditService');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The live effective configuration + its defaults, for the admin console. */
exports.getPricingConfig = asyncHandler(async (req, res) => {
  const rules = await resolvePricingRules();
  const active = await PricingRule.findOne({ isActive: true }).sort({ version: -1 }).lean();
  return res.json({
    success: true,
    data: {
      rules,
      defaults: ENGINE_DEFAULTS,
      overridableKeys: OVERRIDABLE_KEYS,
      activeRule: active ? { _id: active._id, version: active.version, label: active.label, updatedAt: active.updatedAt } : null,
    },
  });
});

/** GET /api/admin/pricing/rules — the version history. */
exports.listRules = asyncHandler(async (req, res) => {
  const rules = await PricingRule.find().sort({ version: -1 }).limit(50).lean();
  return res.json({ success: true, data: rules });
});

/**
 * PUT /api/admin/pricing/rules
 * Body: { rules: {...}, label?: string }
 *
 * Creates a NEW versioned rule set (never mutates a historical one) and makes
 * it active. Every changed key is audited with its old and new value.
 */
exports.updatePricingRules = asyncHandler(async (req, res) => {
  const patch = isPlainObject(req.body?.rules) ? req.body.rules : req.body;
  if (!isPlainObject(patch) || !Object.keys(patch).length) {
    return res.status(400).json({ success: false, message: 'A non-empty rules object is required.' });
  }

  // Validate: only known keys; unknown keys are reported and skipped.
  const accepted = {};
  const skipped = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!OVERRIDABLE_KEYS.includes(key)) { skipped.push(key); continue; }
    accepted[key] = value;
  }
  if (!Object.keys(accepted).length) {
    return res.status(400).json({ success: false, message: 'No valid pricing rule keys were supplied.', skipped });
  }

  const before = await resolvePricingRules();
  const merged = mergeRules(before, accepted);
  const newVersionString = versionOf(merged);

  // Build the per-key audit trail against the effective (pre-change) values.
  const changes = [];
  for (const key of Object.keys(accepted)) {
    const oldValue = before[key];
    const newValue = merged[key];
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
    changes.push({
      key,
      oldValue: oldValue === undefined ? null : oldValue,
      newValue,
      by: req.user._id,
      byName: req.user.name || '',
      at: new Date(),
    });
  }

  if (!changes.length) {
    return res.json({ success: true, data: { unchanged: true, rules: before, skipped } });
  }

  const latest = await PricingRule.findOne().sort({ version: -1 }).select('version').lean();
  const nextVersion = (Number(latest?.version) || 0) + 1;

  await PricingRule.updateMany({ isActive: true }, { $set: { isActive: false } });
  const created = await PricingRule.create({
    version: nextVersion,
    label: String(req.body?.label || '').slice(0, 120),
    rules: accepted,
    isActive: true,
    rulesVersion: newVersionString,
    changes,
    createdBy: req.user._id,
    createdByName: req.user.name || '',
  });

  const effective = await resolvePricingRules();

  await logAdminAction(req, {
    action: 'pricing.rules.update',
    targetType: 'platform',
    targetId: created._id,
    targetLabel: `Pricing rules v${nextVersion}`,
    oldValue: Object.fromEntries(changes.map(c => [c.key, c.oldValue])),
    newValue: Object.fromEntries(changes.map(c => [c.key, c.newValue])),
  });

  return res.json({
    success: true,
    data: {
      version: nextVersion,
      rulesVersion: newVersionString,
      changes,
      skipped,
      rules: effective,
    },
  });
});

/** GET /api/admin/pricing/snapshot/:orderId — the financial record of one order. */
exports.getOrderSnapshot = asyncHandler(async (req, res) => {
  const snapshot = await OrderFinancialSnapshot.findOne({ order: req.params.orderId }).lean();
  if (!snapshot) return res.status(404).json({ success: false, message: 'No financial snapshot for that order.' });
  return res.json({ success: true, data: snapshot });
});

/** GET /api/admin/pricing/contribution — aggregate projected vs actual contribution. */
exports.getContributionSummary = asyncHandler(async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query?.days) || 7));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await OrderFinancialSnapshot.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $group: {
      _id: null,
      orders: { $sum: 1 },
      projectedContributionPaise: { $sum: '$projected.expectedContributionPaise' },
      requiredContributionPaise: { $sum: '$projected.minimumRequiredContributionPaise' },
      riderPayoutPaise: { $sum: '$projected.riderGuaranteedPayoutPaise' },
      upliftPaise: { $sum: '$projected.foodPriceUpliftPaise' },
      actualContributionPaise: { $sum: { $ifNull: ['$actuals.actualContributionPaise', '$projected.expectedContributionPaise'] } },
    } },
  ]);

  const r = rows[0] || {};
  return res.json({
    success: true,
    data: {
      windowDays: days,
      orders: r.orders || 0,
      projectedContributionRupees: (r.projectedContributionPaise || 0) / 100,
      requiredContributionRupees: (r.requiredContributionPaise || 0) / 100,
      actualContributionRupees: (r.actualContributionPaise || 0) / 100,
      riderPayoutRupees: (r.riderPayoutPaise || 0) / 100,
      foodPriceUpliftRupees: (r.upliftPaise || 0) / 100,
    },
  });
});

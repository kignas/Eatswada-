'use strict';

// ─────────────────────────────────────────────────────────────────────
// PricingRule — versioned, audited pricing rule sets.
//
// A PricingRule document is an OPTIONAL, additive override layer on top of
// the pricing engine defaults and the existing PlatformSetting registry. Only
// one rule set is active at a time (`isActive: true`, highest `version`).
//
// Every admin mutation records who changed what and the old/new value, so a
// bill can always be explained after the fact. Historical rule sets are kept
// (never deleted) because a financial snapshot references its rule version.
// ─────────────────────────────────────────────────────────────────────

const mongoose = require('mongoose');

const ruleChangeSchema = new mongoose.Schema({
  _id: false,
  key: { type: String, required: true },
  oldValue: { type: mongoose.Schema.Types.Mixed, default: null },
  newValue: { type: mongoose.Schema.Types.Mixed, default: null },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  byName: { type: String, default: '' },
  at: { type: Date, default: Date.now },
}, { _id: false });

const pricingRuleSchema = new mongoose.Schema({
  // Monotonic version number. The highest active version wins.
  version: { type: Number, required: true, index: true },
  label: { type: String, trim: true, maxlength: 120, default: '' },
  // The override object; merged onto ENGINE_DEFAULTS by pricingRules.mergeRules.
  rules: { type: mongoose.Schema.Types.Mixed, default: {} },
  isActive: { type: Boolean, default: false, index: true },
  // Deterministic hash of the effective rule set (see pricingRules.versionOf).
  rulesVersion: { type: String, trim: true, default: '', index: true },
  // Full audit trail of every field change applied to this rule set.
  changes: { type: [ruleChangeSchema], default: [] },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdByName: { type: String, default: '' },
}, { timestamps: true });

pricingRuleSchema.index({ isActive: 1, version: -1 });

module.exports = mongoose.models.PricingRule || mongoose.model('PricingRule', pricingRuleSchema);

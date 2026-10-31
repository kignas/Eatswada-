'use strict';

// Read-only staging/production configuration inspection. This script never
// writes settings. Use a staging MONGO_URI first and review the output before
// applying any policy change through the authenticated Admin pricing screen.
require('dotenv').config();
const mongoose = require('mongoose');
const PlatformSetting = require('../models/PlatformSetting');
const PricingRule = require('../models/PricingRule');
const { resolvePricingRules, ENGINE_DEFAULTS } = require('../services/pricing/pricingRules');
const { getPlatformSettings } = require('../services/platformSettingsService');

const KEYS = [
  'platformMinimumOrderRupees',
  'smallOrderFeeMax',
  'smallOrderFeeEnabled',
  'contributionTiers',
  'foodPriceUpliftPercent',
  'menuPricesIncludeUplift',
  'minimumOrderEnabled',
  'riderMinPayout',
  'riderPerKmPayout',
  'deliveryFeeBands',
  'smallCartThreshold',
  'smallCartFee',
];

(async () => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required. Point this script at the STAGING database first.');
  await mongoose.connect(process.env.MONGO_URI);
  const [rows, activeRule, effective, platformSettings] = await Promise.all([
    PlatformSetting.find({ $or: [{ key: 'platform' }, { key: { $in: KEYS } }] }).lean(),
    PricingRule.findOne({ isActive: true }).sort({ version: -1 }).lean(),
    resolvePricingRules(),
    getPlatformSettings(),
  ]);

  const platformOverrides = {};
  for (const row of rows) {
    if (row.key === 'platform') {
      for (const key of KEYS) if (row[key] !== undefined) platformOverrides[key] = row[key];
    } else if (KEYS.includes(row.key)) platformOverrides[row.key] = row.value;
  }
  const pick = (source) => Object.fromEntries(KEYS.filter(k => source[k] !== undefined).map(k => [k, source[k]]));

  console.log(JSON.stringify({
    readOnly: true,
    database: mongoose.connection.name,
    defaults: pick(ENGINE_DEFAULTS),
    platformSettingOverrides: platformOverrides,
    activePricingRule: activeRule ? {
      id: String(activeRule._id),
      version: activeRule.version,
      label: activeRule.label,
      updatedAt: activeRule.updatedAt,
      rules: pick(activeRule.rules || {}),
    } : null,
    effectiveRules: pick(effective),
    effectiveLegacyPlatformSettings: {
      smallCartThreshold: platformSettings.smallCartThreshold,
      smallCartFee: platformSettings.smallCartFee,
    },
    requestedPolicyMatchesEffective: effective.platformMinimumOrderRupees === 99
      && effective.smallOrderFeeMax === 8
      && effective.foodPriceUpliftPercent === 30
      && platformSettings.smallCartThreshold === 99
      && platformSettings.smallCartFee === 8
      && JSON.stringify(effective.contributionTiers) === JSON.stringify([
        { maxBasket: 299, target: 3 },
        { maxBasket: 399, target: 8 },
        { maxBasket: 499, target: 12 },
        { maxBasket: 699, target: 20 },
        { maxBasket: null, target: 20 },
      ]),
  }, null, 2));
  await mongoose.disconnect();
})().catch(async (error) => {
  console.error('[pricing override inspection failed]', error.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exitCode = 1;
});

'use strict';

// ─────────────────────────────────────────────────────────────────────
// Dynamic-pricing rule resolution.
//
// One place decides the complete, frozen rule set the pricing engine runs
// on. Precedence (lowest -> highest):
//
//   1. ENGINE_DEFAULTS      — safe, documented launch defaults (this file)
//   2. PlatformSetting rows — the key/value registry the Admin console
//                             already writes (GET/PUT /api/platform/config)
//   3. the active PricingRule document — a versioned, audited rule set
//
// The merged result is deep-frozen and stamped with a deterministic version
// string, which is stored on every quote and financial snapshot so a bill can
// always be reproduced from the exact rules that produced it.
//
// Rules are stored in RUPEES (what the Admin console shows). Engines convert
// to integer paise with services/pricing/money. Keeping one unit at the config
// boundary avoids a class of "is this paise or rupees" bugs.
// ─────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

const ENGINE_DEFAULTS = Object.freeze({
  // ── Master switch ──────────────────────────────────────────────────
  // Enabled by default: new deployments use the authoritative distance/profitability engine.
  // Existing explicit admin overrides remain effective until migrated/changed.
  pricingEngineEnabled: true,

  // ── Business model: customer-funded online food-price uplift ───────
  foodPriceUpliftPercent: 30,
  // Additional contractual restaurant charge, if any. Separate from the
  // uplift and separately accounted; 0 means none.
  restaurantChargePercent: 0,

  // ── Delivery serviceability + customer delivery fee bands ──────────
  maxDeliveryDistanceKm: 10,
  deliveryFeeBands: [
    { maxKm: 1, fee: 8 },
    { maxKm: 4, fee: 22 },
    { maxKm: 6, fee: 33 },
    { maxKm: 10, fee: 66 },
  ],

  // ── Rider payout model ─────────────────────────────────────────────
  riderBasePayout: 30,
  riderPerKmPayout: 9,
  riderFreeFirstKm: 1,
  riderPickupPerKm: 3,
  riderRepositionPerKm: 3,
  riderWaitPayPerMin: 1,
  riderMinPayout: 30,
  riderPeakBonus: 0,
  riderRemoteZoneBonus: 0,
  // Guaranteed-payout floor is never reduced once accepted.
  riderRepositionEnabled: true,

  // ── Vehicle operating-cost model (separate from gross payout) ──────
  petrolPricePerLitre: 105,
  motorcycleMileageKmPerLitre: 45,
  maintenanceCostPerKm: 1.5,

  // ── Payment / tax ──────────────────────────────────────────────────
  paymentGatewayFeePercent: 2,
  paymentGatewayFeeFixed: 0,
  paymentGatewayFeeTaxPercent: 18,
  // GST on Eatswada's platform service (the food-price uplift). The uplift is
  // gross revenue, not tax-free profit; this models the tax liability on it.
  gstOnUpliftPercent: 18,

  // ── Contribution targets by food-basket band ───────────────────────
  // maxBasket null = open-ended top band.
  contributionTiers: [
    { maxBasket: 199, target: 5 },
    { maxBasket: 399, target: 8 },
    { maxBasket: 499, target: 12 },
    { maxBasket: 699, target: 20 },
    { maxBasket: null, target: 20 },
  ],

  // ── Small-order fee ────────────────────────────────────────────────
  smallOrderFeeEnabled: true,
  smallOrderFeeMax: 15,

  // ── COD handling fee ───────────────────────────────────────────────
  // The fee is justified by a REAL modelled cost (below), not a penalty.
  codHandlingFeeEnabled: true,
  codHandlingFeePercent: 1.5,
  codHandlingFeeFixed: 0,
  codHandlingFeeMax: 20,
  // Cash collection / reconciliation cost and failed-delivery risk, applied to
  // the cash the rider must collect. Drives the COD operational expense line.
  codCashHandlingPercent: 0.75,
  codCashHandlingFixed: 0,
  codFailedDeliveryRiskPercent: 0.5,

  // ── Free delivery ──────────────────────────────────────────────────
  freeDeliveryEnabled: true,
  freeDeliveryThreshold: 0, // no fixed basket threshold; profitability + distance determine the unlock point
  // Conservative pickup distance assumed when no rider is assigned yet (i.e.
  // on a restaurant card or at the start of checkout). The threshold must be
  // quoted against a trip the engine will actually be able to fund once a real
  // rider is chosen, so it never assumes a free pickup leg.
  freeDeliveryAssumedPickupKm: 1,
  firstOrderFreeDeliveryEnabled: true,
  firstOrderFreeDeliveryMaxKm: 4,
  firstOrderFreeDeliveryMaxSubsidy: 22,
  firstOrderFreeDeliveryMinBasket: 0,

  // ── Legacy commission model (opt-in) ───────────────────────────────
  // OFF by default: the food-price uplift is the platform's revenue model.
  // When enabled, restaurants on a legacy/custom commission plan are charged
  // commission INSTEAD of the uplift, so the same money is never counted twice.
  legacyCommissionModelEnabled: false,

  // ── Automatic discount optimiser ───────────────────────────────────
  discountOptimizerEnabled: true,
  // OFF by default: the optimiser always REPORTS the maximum affordable
  // discount, but a discount is only folded into the bill when an admin
  // explicitly opts in. "Do not automatically offer a discount simply because
  // a large basket exists."
  discountAutoApplyEnabled: false,
  discountSafetyReserve: 10,
  discountMinAmount: 0,
  discountMaxAmount: 50,
  // null = unlimited campaign budget for the window.
  promotionBudgetRemaining: null,

  // ── Risk allowances ────────────────────────────────────────────────
  cancellationRiskPercent: 2,
  refundRiskPercent: 2,

  // ── Peak / remote-zone window ──────────────────────────────────────
  // 24h local (Asia/Kolkata) window during which the peak allowance applies.
  peakHourStartHour: 12,
  peakHourEndHour: 15,
});

// Rule fields that the Admin console may override through PlatformSetting or a
// PricingRule document. Anything else is ignored (fail-closed, additive).
const OVERRIDABLE_KEYS = Object.freeze(Object.keys(ENGINE_DEFAULTS));

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clampNumber(value, { min = -Infinity, max = Infinity, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function clampBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  if (value === 0 || value === 1) return value === 1;
  return fallback;
}

/** Normalise a delivery-band list into ascending maxKm order with valid fees. */
function normaliseBands(raw, fallback) {
  if (!Array.isArray(raw) || raw.length === 0) return fallback.map(b => ({ ...b }));
  const cleaned = raw
    .map(band => ({
      maxKm: clampNumber(band?.maxKm, { min: 0, max: 1000, fallback: NaN }),
      fee: clampNumber(band?.fee, { min: 0, max: 100000, fallback: NaN }),
    }))
    .filter(band => Number.isFinite(band.maxKm) && Number.isFinite(band.fee))
    .sort((a, b) => a.maxKm - b.maxKm);
  return cleaned.length ? cleaned : fallback.map(b => ({ ...b }));
}

/** Normalise the contribution tiers into ascending maxBasket order. */
function normaliseTiers(raw, fallback) {
  if (!Array.isArray(raw) || raw.length === 0) return fallback.map(t => ({ ...t }));
  const cleaned = raw
    .map(tier => {
      const maxBasket = tier?.maxBasket === null || tier?.maxBasket === undefined
        ? null
        : clampNumber(tier.maxBasket, { min: 0, max: 1000000, fallback: NaN });
      return { maxBasket, target: clampNumber(tier?.target, { min: 0, max: 100000, fallback: NaN }) };
    })
    .filter(tier => (tier.maxBasket === null || Number.isFinite(tier.maxBasket)) && Number.isFinite(tier.target))
    .sort((a, b) => {
      if (a.maxBasket === null) return 1;
      if (b.maxBasket === null) return -1;
      return a.maxBasket - b.maxBasket;
    });
  return cleaned.length ? cleaned : fallback.map(t => ({ ...t }));
}

/**
 * Merge a raw override object onto a base rule set, coercing every field to
 * its expected shape. Unknown keys are dropped; malformed values fall back to
 * the base. Never throws.
 */
function mergeRules(base, raw) {
  const out = { ...base };
  if (!isPlainObject(raw)) return out;

  for (const key of OVERRIDABLE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key) || raw[key] === undefined || raw[key] === null) continue;
    const value = raw[key];
    switch (key) {
      case 'deliveryFeeBands':
        out.deliveryFeeBands = normaliseBands(value, base.deliveryFeeBands);
        break;
      case 'contributionTiers':
        out.contributionTiers = normaliseTiers(value, base.contributionTiers);
        break;
      case 'pricingEngineEnabled':
      case 'riderRepositionEnabled':
      case 'smallOrderFeeEnabled':
      case 'codHandlingFeeEnabled':
      case 'freeDeliveryEnabled':
      case 'firstOrderFreeDeliveryEnabled':
      case 'discountOptimizerEnabled':
      case 'discountAutoApplyEnabled':
      case 'legacyCommissionModelEnabled':
        out[key] = clampBoolean(value, base[key]);
        break;
      case 'promotionBudgetRemaining': {
        const n = Number(value);
        out[key] = Number.isFinite(n) && n >= 0 ? n : base[key];
        break;
      }
      case 'foodPriceUpliftPercent':
        out[key] = clampNumber(value, { min: 0, max: 500, fallback: base[key] });
        break;
      case 'restaurantChargePercent':
      case 'paymentGatewayFeePercent':
      case 'paymentGatewayFeeTaxPercent':
      case 'gstOnUpliftPercent':
      case 'codHandlingFeePercent':
      case 'codCashHandlingPercent':
      case 'codFailedDeliveryRiskPercent':
      case 'cancellationRiskPercent':
      case 'refundRiskPercent':
        out[key] = clampNumber(value, { min: 0, max: 100, fallback: base[key] });
        break;
      case 'peakHourStartHour':
      case 'peakHourEndHour':
        out[key] = clampNumber(value, { min: 0, max: 23, fallback: base[key] });
        break;
      case 'maxDeliveryDistanceKm':
        out[key] = clampNumber(value, { min: 0.5, max: 100, fallback: base[key] });
        break;
      case 'freeDeliveryAssumedPickupKm':
        out[key] = clampNumber(value, { min: 0, max: 50, fallback: base[key] });
        break;
      default:
        out[key] = clampNumber(value, { min: 0, max: 1000000, fallback: base[key] });
    }
  }
  return out;
}

/** Deterministic version string for a resolved rule set. */
function versionOf(rules) {
  const canonical = JSON.stringify({
    foodPriceUpliftPercent: rules.foodPriceUpliftPercent,
    restaurantChargePercent: rules.restaurantChargePercent,
    legacyCommissionModelEnabled: rules.legacyCommissionModelEnabled === true,
    discountAutoApplyEnabled: rules.discountAutoApplyEnabled === true,
    maxDeliveryDistanceKm: rules.maxDeliveryDistanceKm,
    deliveryFeeBands: rules.deliveryFeeBands,
    riderBasePayout: rules.riderBasePayout,
    riderPerKmPayout: rules.riderPerKmPayout,
    riderFreeFirstKm: rules.riderFreeFirstKm,
    riderPickupPerKm: rules.riderPickupPerKm,
    riderRepositionPerKm: rules.riderRepositionPerKm,
    freeDeliveryThreshold: rules.freeDeliveryThreshold,
    freeDeliveryAssumedPickupKm: rules.freeDeliveryAssumedPickupKm,
    riderWaitPayPerMin: rules.riderWaitPayPerMin,
    riderMinPayout: rules.riderMinPayout,
    riderPeakBonus: rules.riderPeakBonus,
    riderRemoteZoneBonus: rules.riderRemoteZoneBonus,
    petrolPricePerLitre: rules.petrolPricePerLitre,
    motorcycleMileageKmPerLitre: rules.motorcycleMileageKmPerLitre,
    maintenanceCostPerKm: rules.maintenanceCostPerKm,
    paymentGatewayFeePercent: rules.paymentGatewayFeePercent,
    paymentGatewayFeeFixed: rules.paymentGatewayFeeFixed,
    paymentGatewayFeeTaxPercent: rules.paymentGatewayFeeTaxPercent,
    gstOnUpliftPercent: rules.gstOnUpliftPercent,
    contributionTiers: rules.contributionTiers,
    smallOrderFeeMax: rules.smallOrderFeeMax,
    codHandlingFeePercent: rules.codHandlingFeePercent,
    codHandlingFeeFixed: rules.codHandlingFeeFixed,
    codHandlingFeeMax: rules.codHandlingFeeMax,
    codCashHandlingPercent: rules.codCashHandlingPercent,
    codCashHandlingFixed: rules.codCashHandlingFixed,
    codFailedDeliveryRiskPercent: rules.codFailedDeliveryRiskPercent,
    freeDeliveryThreshold: rules.freeDeliveryThreshold,
    firstOrderFreeDeliveryMaxKm: rules.firstOrderFreeDeliveryMaxKm,
    firstOrderFreeDeliveryMaxSubsidy: rules.firstOrderFreeDeliveryMaxSubsidy,
    discountSafetyReserve: rules.discountSafetyReserve,
    discountMaxAmount: rules.discountMaxAmount,
    cancellationRiskPercent: rules.cancellationRiskPercent,
    refundRiskPercent: rules.refundRiskPercent,
  });
  return `pr_${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

function deepFreeze(rules) {
  Object.freeze(rules.deliveryFeeBands.map(b => Object.freeze(b)));
  Object.freeze(rules.contributionTiers.map(t => Object.freeze(t)));
  Object.freeze(rules.deliveryFeeBands);
  Object.freeze(rules.contributionTiers);
  return Object.freeze(rules);
}

/** Build a frozen rule set (with version) from an arbitrary override object. */
function buildRules(overrides = {}) {
  const merged = mergeRules(ENGINE_DEFAULTS, overrides);
  const rules = { ...merged, version: versionOf(merged) };
  return deepFreeze(rules);
}

/**
 * Resolve the authoritative rule set for this deployment.
 *
 * Reads the PlatformSetting registry (the same collection the Admin console
 * writes) and, when present, the active PricingRule document. Both are pure
 * additive overrides of ENGINE_DEFAULTS, so a read failure can never wedge
 * checkout — it simply falls back to the last-known/default rules.
 */
async function resolvePricingRules({ overrides = null } = {}) {
  let fromSettings = null;
  let fromRuleDoc = null;

  try {
    const Setting = require('../../models/PlatformSetting');
    const rows = await Setting.find({
      $or: [
        { key: 'platform' },
        { key: { $in: OVERRIDABLE_KEYS } },
      ],
    }).lean();
    const patch = {};
    for (const row of rows) {
      const key = String(row?.key || '');
      if (key === 'platform') {
        if (isPlainObject(row)) {
          for (const k of OVERRIDABLE_KEYS) {
            if (row[k] !== undefined && row[k] !== null) patch[k] = row[k];
          }
        }
        continue;
      }
      if (OVERRIDABLE_KEYS.includes(key)) patch[key] = row.value;
    }
    if (Object.keys(patch).length) fromSettings = patch;
  } catch (err) {
    console.error('[pricing] could not read PlatformSetting overrides:', err.message);
  }

  try {
    const PricingRule = require('../../models/PricingRule');
    const active = await PricingRule.findOne({ isActive: true }).sort({ version: -1 }).lean();
    if (active && isPlainObject(active.rules)) fromRuleDoc = active.rules;
  } catch (err) {
    console.error('[pricing] could not read active PricingRule:', err.message);
  }

  const merged = mergeRules(mergeRules(ENGINE_DEFAULTS, fromSettings), fromRuleDoc);
  const final = mergeRules(merged, overrides);
  const rules = { ...final, version: versionOf(final) };
  return deepFreeze(rules);
}

module.exports = {
  ENGINE_DEFAULTS,
  OVERRIDABLE_KEYS,
  mergeRules,
  buildRules,
  versionOf,
  resolvePricingRules,
};

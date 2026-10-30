'use strict';

// ─────────────────────────────────────────────────────────────────────
// Platform settings registry.
//
// The Admin Command Center stores configuration in the existing
// PlatformSetting key/value collection (see controllers/platformController).
// This service adds a TYPED registry on top of it so backend consumers
// (checkout, dispatch, settlements) read one merged, validated view with
// sane production defaults instead of re-implementing fallbacks everywhere.
//
// Backward compatibility: every key is additive. The legacy key/value
// contract (GET/PUT /platform/settings) is unchanged — this module only
// widens the set of keys the backend understands and gives them defaults.
// ─────────────────────────────────────────────────────────────────────

const Setting = require('../models/PlatformSetting');

// The singleton document key the Admin console writes through
// PUT /platform/config. Its typed fields override the per-key rows.
const CONFIG_KEY = 'platform';

const DEFAULT_PLATFORM_SETTINGS = Object.freeze({
  // ── Pillar 1: maintenance + rider-shortage circuit breaker ──
  isUnderMaintenance: false,
  maintenanceTitle: 'Eatswada is under maintenance',
  maintenanceMessage: 'Ordering is paused for a short scheduled upgrade. Please try again soon.',
  maintenanceEta: '',
  isDeliveryPausedShortage: false,
  autoShortageCircuitBreaker: true,
  maxActiveOrdersPerOnlineRider: 3,
  shortageBannerMessage: 'All delivery partners are busy right now. Ordering is paused briefly.',
  isRainSurgeActive: false,
  rainSurgeFee: 15,
  rainExtraEtaMinutes: 10,

  // ── Pillar 2: checkout bill + delivery pricing controller ──
  isGlobalFreeDelivery: false,
  freeDeliveryMinSubtotal: 199,
  isFirstOrderFreeDelivery: false,
  baseDeliveryFee: 25,
  baseDistanceKm: 2,
  perKmExtraFee: 8,
  platformHandlingFee: 5,
  smallCartThreshold: 99,
  smallCartFee: 15,
  packagingChargePerItem: 0,
  taxPercent: 0,

  // ── Pillar 3: dual payment engine ──
  isUpiEnabled: true,
  isCodEnabled: true,
  maxCodOrderAmount: 1000,
  codAdvanceThreshold: 1000,
  codAdvancePercent: 10,
  codAutoBlockEnabled: false,
  codMaxRefusalsBeforeAutoBlock: 3,
  codDisplayLabel: 'Cash on Delivery — Free',

  // ── Pillar 6: rider pay model ──
  riderBasePay: 25,
  riderPerKmPay: 5,
  riderWaitTimePayPerMin: 1,
  riderRainSurgeBonus: 15,
  // Rider distance pay is capped at riderMaxDistanceKm × riderPerKmPay so a
  // long trip cannot produce an unbounded payout (e.g. 3 km × ₹5 = ₹15 cap).
  riderMaxDistanceKm: 3,

  // ── Dynamic pricing & profitability engine (additive, opt-in) ──
  // The full rule set lives in services/pricing/pricingRules (ENGINE_DEFAULTS)
  // and may be overridden per key here or by an active PricingRule document.
  // Only the headline switches are mirrored into this typed registry so the
  // existing Admin -> Platform config screen can toggle them; the deep rule
  // editor lives at Admin -> Financial Management -> Dynamic Pricing.
  pricingEngineEnabled: false,
  foodPriceUpliftPercent: 30,
  maxDeliveryDistanceKm: 10,
  riderBasePayout: 30,
  riderPerKmPayout: 9,
  riderMinPayout: 30,
  petrolPricePerLitre: 105,
  motorcycleMileageKmPerLitre: 45,
  maintenanceCostPerKm: 1.5,
  smallOrderFeeMax: 15,
  codHandlingFeeEnabled: true,
  codHandlingFeePercent: 1.5,
  codHandlingFeeMax: 20,
  freeDeliveryThreshold: 299,
  firstOrderFreeDeliveryEnabled: true,
  firstOrderFreeDeliveryMaxKm: 4,
  firstOrderFreeDeliveryMaxSubsidy: 22,
  discountSafetyReserve: 10,
  discountMinAmount: 0,
  discountMaxAmount: 50,
});

const BOOLEAN_KEYS = new Set([
  'isUnderMaintenance', 'isDeliveryPausedShortage', 'autoShortageCircuitBreaker',
  'isRainSurgeActive', 'isGlobalFreeDelivery', 'isFirstOrderFreeDelivery',
  'isUpiEnabled', 'isCodEnabled', 'codAutoBlockEnabled',
  'pricingEngineEnabled', 'codHandlingFeeEnabled', 'firstOrderFreeDeliveryEnabled',
]);

const NUMBER_KEYS = new Set([
  'maxActiveOrdersPerOnlineRider', 'rainSurgeFee', 'rainExtraEtaMinutes',
  'freeDeliveryMinSubtotal', 'baseDeliveryFee', 'baseDistanceKm', 'perKmExtraFee',
  'platformHandlingFee', 'smallCartThreshold', 'smallCartFee',
  'packagingChargePerItem', 'taxPercent', 'maxCodOrderAmount',
  'codAdvanceThreshold', 'codAdvancePercent', 'codMaxRefusalsBeforeAutoBlock',
  'riderBasePay', 'riderPerKmPay', 'riderWaitTimePayPerMin', 'riderRainSurgeBonus',
  'riderMaxDistanceKm',
  'foodPriceUpliftPercent', 'maxDeliveryDistanceKm', 'riderBasePayout', 'riderPerKmPayout',
  'riderMinPayout', 'petrolPricePerLitre', 'motorcycleMileageKmPerLitre',
  'maintenanceCostPerKm', 'smallOrderFeeMax', 'codHandlingFeePercent', 'codHandlingFeeMax',
  'freeDeliveryThreshold', 'firstOrderFreeDeliveryMaxKm', 'firstOrderFreeDeliveryMaxSubsidy',
  'discountSafetyReserve', 'discountMinAmount', 'discountMaxAmount',
]);

const MIN_ZERO_KEYS = new Set([
  'rainSurgeFee', 'rainExtraEtaMinutes', 'freeDeliveryMinSubtotal', 'baseDeliveryFee',
  'baseDistanceKm', 'perKmExtraFee', 'platformHandlingFee', 'smallCartThreshold',
  'smallCartFee', 'packagingChargePerItem', 'taxPercent', 'maxCodOrderAmount',
  'codAdvanceThreshold', 'codAdvancePercent', 'codMaxRefusalsBeforeAutoBlock',
  'riderBasePay', 'riderPerKmPay', 'riderWaitTimePayPerMin', 'riderRainSurgeBonus',
  'riderMaxDistanceKm',
  'foodPriceUpliftPercent', 'maxDeliveryDistanceKm', 'riderBasePayout', 'riderPerKmPayout',
  'riderMinPayout', 'petrolPricePerLitre', 'motorcycleMileageKmPerLitre',
  'maintenanceCostPerKm', 'smallOrderFeeMax', 'codHandlingFeePercent', 'codHandlingFeeMax',
  'freeDeliveryThreshold', 'firstOrderFreeDeliveryMaxKm', 'firstOrderFreeDeliveryMaxSubsidy',
  'discountSafetyReserve', 'discountMinAmount', 'discountMaxAmount',
]);

const STRING_KEYS = new Set(['maintenanceTitle', 'maintenanceMessage', 'maintenanceEta', 'shortageBannerMessage', 'codDisplayLabel']);

const STRING_MAX = 500;

function isKnownKey(key) {
  return Object.prototype.hasOwnProperty.call(DEFAULT_PLATFORM_SETTINGS, key);
}

/** Coerce a stored/raw value into the type the registry expects. */
function coerceSetting(key, raw) {
  if (raw === undefined) return undefined;
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
    return Boolean(raw);
  }
  if (NUMBER_KEYS.has(key)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    if (MIN_ZERO_KEYS.has(key)) return Math.max(0, n);
    return n;
  }
  if (STRING_KEYS.has(key)) {
    return String(raw ?? '').slice(0, STRING_MAX);
  }
  return raw;
}

/** The registry defaults, coerced and frozen for callers. */
function defaultSettings() {
  return { ...DEFAULT_PLATFORM_SETTINGS };
}

/**
 * Read the full merged settings view: registry defaults overridden by any
 * stored PlatformSetting row, then by the singleton `key: 'platform'`
 * document (the shape the Admin console writes through the config endpoint).
 * Never throws on a malformed row — a bad value simply falls back to the
 * default so checkout can never be wedged by one.
 */
async function getPlatformSettings() {
  const merged = defaultSettings();
  let rows = [];
  try {
    rows = await Setting.find().lean();
  } catch (err) {
    console.error('[settings] could not load platform settings:', err.message);
    return merged;
  }
  for (const row of rows) {
    const key = String(row?.key || '');
    if (!isKnownKey(key)) continue;
    const value = coerceSetting(key, row.value);
    if (value !== undefined) merged[key] = value;
  }

  // The structured singleton (if any) is authoritative for its own fields.
  const singleton = rows.find(row => String(row?.key || '') === CONFIG_KEY);
  if (singleton) {
    for (const key of Object.keys(DEFAULT_PLATFORM_SETTINGS)) {
      if (singleton[key] === undefined || singleton[key] === null) continue;
      const value = coerceSetting(key, singleton[key]);
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

/**
 * Write a validated patch of registry keys. Unknown keys and malformed
 * values are reported rather than written. Returns { updated, skipped }.
 */
async function updatePlatformSettings(patch = {}, updatedBy = null) {
  const updated = {};
  const skipped = [];
  for (const [key, raw] of Object.entries(patch || {})) {
    if (!isKnownKey(key)) { skipped.push(key); continue; }
    const value = coerceSetting(key, raw);
    if (value === undefined) { skipped.push(key); continue; }
    await Setting.findOneAndUpdate(
      { key },
      { $set: { value, updatedBy } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    updated[key] = value;
  }
  return { updated, skipped };
}

/**
 * Write a validated patch onto the structured singleton document
 * (key: 'platform'). This is the path the Admin console's toggle switches
 * use, so every Pillar-1/2/3/6 control has one atomic write. Returns
 * { updated, skipped, settings } with the freshly merged view.
 */
async function updatePlatformConfig(patch = {}, updatedBy = null) {
  const updated = {};
  const skipped = [];
  const set = {};
  for (const [key, raw] of Object.entries(patch || {})) {
    if (!isKnownKey(key)) { skipped.push(key); continue; }
    const value = coerceSetting(key, raw);
    if (value === undefined) { skipped.push(key); continue; }
    set[key] = value;
    updated[key] = value;
  }
  if (Object.keys(set).length) {
    await Setting.findOneAndUpdate(
      { key: CONFIG_KEY },
      { $set: { ...set, updatedBy } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }
  return { updated, skipped, settings: await getPlatformSettings() };
}

/**
 * Delivery/checkout policy snapshot used by checkout. Kept separate so the
 * controller reads intent, not raw keys.
 */
function billPolicyFrom(settings) {
  return {
    baseDeliveryFee: Number(settings.baseDeliveryFee),
    baseDistanceKm: Number(settings.baseDistanceKm),
    perKmExtraFee: Number(settings.perKmExtraFee),
    platformHandlingFee: Number(settings.platformHandlingFee),
    smallCartThreshold: Number(settings.smallCartThreshold),
    smallCartFee: Number(settings.smallCartFee),
    packagingChargePerItem: Number(settings.packagingChargePerItem),
    taxPercent: Number(settings.taxPercent),
    isGlobalFreeDelivery: settings.isGlobalFreeDelivery === true,
    freeDeliveryMinSubtotal: Number(settings.freeDeliveryMinSubtotal),
    isFirstOrderFreeDelivery: settings.isFirstOrderFreeDelivery === true,
    isRainSurgeActive: settings.isRainSurgeActive === true,
    rainSurgeFee: Number(settings.rainSurgeFee),
    rainExtraEtaMinutes: Number(settings.rainExtraEtaMinutes),
  };
}

module.exports = {
  CONFIG_KEY,
  DEFAULT_PLATFORM_SETTINGS,
  BOOLEAN_KEYS,
  NUMBER_KEYS,
  STRING_KEYS,
  isKnownKey,
  coerceSetting,
  defaultSettings,
  getPlatformSettings,
  updatePlatformSettings,
  updatePlatformConfig,
  billPolicyFrom,
};

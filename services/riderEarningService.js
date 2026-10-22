'use strict';

const { getPlatformSettings } = require('./platformSettingsService');

/**
 * Pillar 6 — rider earning for one delivered order.
 *   basePay + distancePay + rainSurgeBonus + waitTimePay + tip
 * Settings come from the platform configuration; distancePay uses the order's
 * server-calculated delivery distance, and waitTimePay the rider's confirmed
 * restaurant wait. The breakdown is frozen onto the order at delivery.
 *
 * Shared by the rider delivery endpoint and the Admin force-deliver override so
 * both paths derive the rider's pay from the exact same rules.
 */
async function computeRiderEarning(order) {
  let settings;
  try { settings = await getPlatformSettings(); }
  catch (_) { settings = {}; }

  const basePay = Math.max(0, Number(settings.riderBasePay) || 0);
  const perKm = Math.max(0, Number(settings.riderPerKmPay) || 0);
  const distanceKm = Math.max(0, Number(order.deliveryDistanceKm) || 0);
  const distancePay = Math.round(perKm * distanceKm * 100) / 100;
  const rainSurgeBonus = settings.isRainSurgeActive === true
    ? Math.max(0, Number(settings.riderRainSurgeBonus) || 0)
    : 0;

  // Wait-time pay is measured from arrival to pickup, when both are known.
  let waitTimeMinutes = 0;
  if (order.riderReachedRestaurantAt && order.orderReadyAt) {
    const ms = new Date(order.orderReadyAt).getTime() - new Date(order.riderReachedRestaurantAt).getTime();
    if (Number.isFinite(ms) && ms > 0) waitTimeMinutes = Math.round(ms / 60000);
  } else if (Number(order.riderWaitTimeMinutes) > 0) {
    waitTimeMinutes = Math.round(Number(order.riderWaitTimeMinutes));
  }
  const waitTimePay = Math.round((Math.max(0, Number(settings.riderWaitTimePayPerMin) || 0) * waitTimeMinutes) * 100) / 100;

  const tip = Math.max(0, Number(order.tipAmount) || 0);
  const total = Math.round((basePay + distancePay + rainSurgeBonus + waitTimePay + tip) * 100) / 100;
  return { basePay, distancePay, rainSurgeBonus, waitTimePay, tip, total, waitTimeMinutes };
}

module.exports = { computeRiderEarning };

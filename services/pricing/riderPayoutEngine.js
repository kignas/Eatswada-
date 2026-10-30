'use strict';

// ─────────────────────────────────────────────────────────────────────
// Rider payout engine.
//
// Rider compensation is computed INDEPENDENTLY of the customer delivery fee.
// The customer fee is what Eatswada charges for the service; the payout is
// what the rider is fairly owed for doing the work. They are never equated.
//
// Initial configurable policy (an admin starting point, not a hard rule):
//   minimum base payout        ₹30
//   additional distance payout ₹9 per km beyond the first kilometre
//   pickup travel              ₹3 per km
//   repositioning travel       ₹3 per km (only when no nearby follow-up order)
//   waiting                    ₹1 per minute
//   peak-hour / remote-zone    configurable allowance
//   absolute floor             ₹30 (never paid less, never reduced once accepted)
//
// Vehicle operating costs (fuel + maintenance) are calculated SEPARATELY from
// gross payout so the rider app can show gross, expenses and estimated net
// without conflating them.
//
// All arithmetic is integer paise.
// ─────────────────────────────────────────────────────────────────────

const { toPaise, fromPaise, roundHalfUp } = require('./money');

/** Fuel + maintenance cost for a distance, in integer paise. */
function computeVehicleExpenses({
  totalKm = 0,
  petrolPricePerLitre = 0,
  mileageKmPerLitre = 45,
  maintenanceCostPerKm = 0,
} = {}) {
  const km = Math.max(0, Number(totalKm) || 0);
  const mileage = Number(mileageKmPerLitre);
  const usableMileage = Number.isFinite(mileage) && mileage > 0 ? mileage : 45;

  const fuelLitres = km / usableMileage;
  const fuelPaise = Math.max(0, roundHalfUp(fuelLitres * (Number(petrolPricePerLitre) || 0) * 100));
  const maintenancePaise = Math.max(0, roundHalfUp(km * (Number(maintenanceCostPerKm) || 0) * 100));
  const totalExpensesPaise = fuelPaise + maintenancePaise;

  return {
    totalKm: Math.round(km * 100) / 100,
    fuelLitres: Math.round(fuelLitres * 1000) / 1000,
    fuelPaise,
    maintenancePaise,
    totalExpensesPaise,
    fuelRupees: fromPaise(fuelPaise),
    maintenanceRupees: fromPaise(maintenancePaise),
    totalExpensesRupees: fromPaise(totalExpensesPaise),
  };
}

/**
 * Compute the guaranteed rider payout for a delivery trip.
 *
 * @param {object} args
 * @param {number} args.deliveryKm        restaurant -> customer road distance
 * @param {number} [args.pickupKm]        rider -> restaurant road distance
 * @param {number} [args.repositioningKm] post-delivery travel with no follow-up order
 * @param {number} [args.waitingMinutes]  restaurant prep/wait time
 * @param {boolean} [args.isPeakHour]
 * @param {boolean} [args.isRemoteZone]
 * @param {object} args.rules             resolved pricing rules
 * @returns {object} payout breakdown in integer paise (plus rupee views)
 */
function computeRiderPayout({
  deliveryKm = 0,
  pickupKm = 0,
  repositioningKm = 0,
  waitingMinutes = 0,
  isPeakHour = false,
  isRemoteZone = false,
  rules = {},
} = {}) {
  const delivery = Math.max(0, Number(deliveryKm) || 0);
  const pickup = Math.max(0, Number(pickupKm) || 0);
  const reposition = rules.riderRepositionEnabled === false ? 0 : Math.max(0, Number(repositioningKm) || 0);
  const waitMinutes = Math.max(0, Number(waitingMinutes) || 0);

  const basePaise = Math.max(0, toPaise(rules.riderBasePayout));
  const freeFirstKm = Math.max(0, Number(rules.riderFreeFirstKm) || 0);
  const payableDeliveryKm = Math.max(0, delivery - freeFirstKm);
  const distancePaise = Math.max(0, roundHalfUp(payableDeliveryKm * (Number(rules.riderPerKmPayout) || 0) * 100));
  const pickupPaise = Math.max(0, roundHalfUp(pickup * (Number(rules.riderPickupPerKm) || 0) * 100));
  const repositionPaise = Math.max(0, roundHalfUp(reposition * (Number(rules.riderRepositionPerKm) || 0) * 100));
  const waitPaise = Math.max(0, roundHalfUp(waitMinutes * (Number(rules.riderWaitPayPerMin) || 0) * 100));
  const peakPaise = isPeakHour ? Math.max(0, toPaise(rules.riderPeakBonus)) : 0;
  const remotePaise = isRemoteZone ? Math.max(0, toPaise(rules.riderRemoteZoneBonus)) : 0;

  const subtotalPaise = basePaise + distancePaise + pickupPaise + repositionPaise + waitPaise + peakPaise + remotePaise;
  const floorPaise = Math.max(0, toPaise(rules.riderMinPayout));
  const totalPaise = Math.max(subtotalPaise, floorPaise);

  const expenses = computeVehicleExpenses({
    totalKm: pickup + delivery + reposition,
    petrolPricePerLitre: rules.petrolPricePerLitre,
    mileageKmPerLitre: rules.motorcycleMileageKmPerLitre,
    maintenanceCostPerKm: rules.maintenanceCostPerKm,
  });

  const netPaise = totalPaise - expenses.totalExpensesPaise;

  return {
    basePaise,
    distancePaise,
    pickupPaise,
    repositionPaise,
    waitPaise,
    peakPaise,
    remotePaise,
    subtotalPaise,
    floorApplied: totalPaise > subtotalPaise,
    floorPaise,
    totalPaise,
    // Rupee views (display only).
    baseRupees: fromPaise(basePaise),
    distanceRupees: fromPaise(distancePaise),
    pickupRupees: fromPaise(pickupPaise),
    repositionRupees: fromPaise(repositionPaise),
    waitRupees: fromPaise(waitPaise),
    peakRupees: fromPaise(peakPaise),
    remoteRupees: fromPaise(remotePaise),
    totalRupees: fromPaise(totalPaise),
    // Trip distances actually used (so the rider app can show them).
    trip: {
      pickupKm: Math.round(pickup * 100) / 100,
      deliveryKm: Math.round(delivery * 100) / 100,
      repositioningKm: Math.round(reposition * 100) / 100,
      totalKm: expenses.totalKm,
    },
    expenses,
    estimatedNetPaise: netPaise,
    estimatedNetRupees: fromPaise(netPaise),
  };
}

/**
 * Apply the never-reduce guarantee: an already-accepted payout can only be
 * raised. Returns the effective (higher) payout in paise.
 */
function guaranteePayout(acceptedPaise, proposedPaise) {
  const accepted = Math.max(0, Number(acceptedPaise) || 0);
  const proposed = Math.max(0, Number(proposedPaise) || 0);
  return Math.max(accepted, proposed);
}

/** True when `hour` (0-23, local) falls in the configured peak window. */
function isPeakHourAt(hour, rules = {}) {
  const h = Number(hour);
  if (!Number.isInteger(h) || h < 0 || h > 23) return false;
  const start = Number(rules.peakHourStartHour);
  const end = Number(rules.peakHourEndHour);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start === end) return false;
  if (start < end) return h >= start && h < end;
  // Window wraps past midnight (e.g. 22 -> 2).
  return h >= start || h < end;
}

module.exports = {
  computeRiderPayout,
  computeVehicleExpenses,
  guaranteePayout,
  isPeakHourAt,
};

'use strict';

// ─────────────────────────────────────────────────────────────────────
// Customer delivery-fee engine — admin-configured distance bands.
//
// Launch bands (one-way restaurant -> customer road distance):
//   up to 1 km   -> 8
//   above 1-4 km -> 22
//   above 4-6 km -> 33
//   above 6-10 km-> 66
//
// Band selection is exclusive on the upper edge: a distance of EXACTLY 1 km
// falls in the first band, exactly 4 km in the second, and so on. Distances
// beyond the platform maximum are rejected with DELIVERY_RADIUS_EXCEEDED so
// existing serviceability rules continue to apply.
// ─────────────────────────────────────────────────────────────────────

const { toPaise, fromPaise } = require('./money');

/**
 * @param {object} args
 * @param {number} args.distanceKm       server-computed road distance
 * @param {Array}  args.bands            [{ maxKm, fee }] ascending
 * @param {number} args.maxDistanceKm    platform cap
 * @returns {{feePaise:number,feeRupees:number,bandIndex:number,band:object|null,distanceKm:number}}
 * @throws {Error} DELIVERY_RADIUS_EXCEEDED when beyond the cap
 */
function computeDeliveryFee({ distanceKm, bands, maxDistanceKm = 10 } = {}) {
  const distance = Number(distanceKm);
  if (!Number.isFinite(distance) || distance < 0) {
    const err = new Error('Invalid delivery distance');
    err.statusCode = 400;
    err.code = 'INVALID_DELIVERY_DISTANCE';
    throw err;
  }

  const cap = Number(maxDistanceKm);
  if (Number.isFinite(cap) && cap > 0 && distance > cap) {
    const err = new Error(`Delivery distance exceeds the Eatswada ${cap} km maximum.`);
    err.code = 'DELIVERY_RADIUS_EXCEEDED';
    err.statusCode = 400;
    throw err;
  }

  const list = Array.isArray(bands) && bands.length ? bands : [{ maxKm: cap || 10, fee: 0 }];
  let bandIndex = list.length - 1;
  let band = list[bandIndex];
  for (let i = 0; i < list.length; i += 1) {
    // Exclusive upper edge: distance <= maxKm belongs to this band.
    if (distance <= Number(list[i].maxKm)) { bandIndex = i; band = list[i]; break; }
  }

  const feePaise = Math.max(0, toPaise(band.fee));
  return {
    feePaise,
    feeRupees: fromPaise(feePaise),
    bandIndex,
    band: { maxKm: Number(band.maxKm), fee: Number(band.fee) },
    distanceKm: distance,
  };
}

module.exports = { computeDeliveryFee };

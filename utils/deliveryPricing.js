'use strict';

/**
 * Calculate great-circle distance between two WGS84 coordinates.
 * Coordinates are [longitude, latitude].
 */
function calculateDistanceKm(from, to) {
  if (!Array.isArray(from) || from.length !== 2 || !Array.isArray(to) || to.length !== 2) {
    throw new Error('Both locations must be [longitude, latitude] coordinates.');
  }

  const [fromLng, fromLat] = from.map(Number);
  const [toLng, toLat] = to.map(Number);

  if (![fromLng, fromLat, toLng, toLat].every(Number.isFinite)) {
    throw new Error('Location coordinates must be valid numbers.');
  }
  if (Math.abs(fromLng) > 180 || Math.abs(toLng) > 180 ||
      Math.abs(fromLat) > 90 || Math.abs(toLat) > 90) {
    throw new Error('Location coordinates are out of range.');
  }

  const toRad = deg => deg * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(toLat - fromLat);
  const dLng = toRad(toLng - fromLng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(fromLat)) *
    Math.cos(toRad(toLat)) *
    Math.sin(dLng / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Nearbite delivery pricing:
 *   < 10 km   -> ₹30
 *   10–15 km  -> ₹40
 *   > 15 km   -> ₹50
 */
function getDeliveryFee(distanceKm) {
  const distance = Number(distanceKm);
  if (!Number.isFinite(distance) || distance < 0) {
    throw new Error('Invalid delivery distance.');
  }
  if (distance < 10) return 30;
  if (distance <= 15) return 40;
  return 50;
}

module.exports = { calculateDistanceKm, getDeliveryFee };

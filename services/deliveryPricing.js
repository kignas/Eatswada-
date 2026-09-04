'use strict';

// ─────────────────────────────────────────────────────────────────────
// Server-authoritative delivery geo + fee helpers.
//
// This module is the SINGLE SOURCE OF TRUTH for the Maynaguri launch
// delivery tier and the geo helpers used to price a delivery. It was
// factored out of controllers/orderController.js (unchanged in behaviour)
// so that BOTH the checkout path (orderController) and the cart-preview
// path (cartController) compute delivery the same way, instead of the old
// cart pre-save hook hardcoding its own FREE_DELIVERY_ABOVE / DELIVERY_FEE.
//
// Per-restaurant values (freeDeliveryEnabled, freeDeliveryAbove, minOrder,
// deliveryRadiusKm) are NEVER hardcoded here — callers read those from the
// Restaurant document and combine them with calculateDeliveryFee() below.
//
// Maynaguri launch rule:
//   < 10 km   => ₹30
//   10–15 km  => ₹40
//   > 15 km   => ₹50
// This module has NO external dependencies (no mongoose) so it can be
// unit-tested directly.
// ─────────────────────────────────────────────────────────────────────

const DELIVERY_RULES = Object.freeze({
  UNDER_10_KM: 30,
  FROM_10_TO_15_KM: 40,
  ABOVE_15_KM: 50,
});

const MAX_DELIVERY_RADIUS_KM = 15;

function validCoordinates(coords) {
  return Array.isArray(coords) &&
    coords.length === 2 &&
    Number.isFinite(Number(coords[0])) &&
    Number.isFinite(Number(coords[1])) &&
    Number(coords[0]) >= -180 && Number(coords[0]) <= 180 &&
    Number(coords[1]) >= -90 && Number(coords[1]) <= 90;
}

function isPlaceholderRestaurantLocation(coords) {
  // Restaurant.js currently has Kolkata as a legacy placeholder default.
  // Eatswada launches in Maynaguri, so never use that placeholder for pricing.
  return Array.isArray(coords) &&
    Math.abs(Number(coords[0]) - 88.3832) < 0.000001 &&
    Math.abs(Number(coords[1]) - 22.5726) < 0.000001;
}

function haversineKm(from, to) {
  const [lon1, lat1] = from.map(Number);
  const [lon2, lat2] = to.map(Number);
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calculateDeliveryFee(distanceKm) {
  if (distanceKm < 10) return DELIVERY_RULES.UNDER_10_KM;
  if (distanceKm <= 15) return DELIVERY_RULES.FROM_10_TO_15_KM;
  return DELIVERY_RULES.ABOVE_15_KM;
}

/**
 * Resolve the effective per-restaurant delivery radius: the admin-configured
 * radius clamped to the platform-wide launch cap. Mirrors the logic used in
 * the checkout path.
 */
function effectiveDeliveryRadiusKm(restaurantConfiguredRadius) {
  const configured = Number(restaurantConfiguredRadius);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, MAX_DELIVERY_RADIUS_KM)
    : MAX_DELIVERY_RADIUS_KM;
}

module.exports = {
  DELIVERY_RULES,
  MAX_DELIVERY_RADIUS_KM,
  validCoordinates,
  isPlaceholderRestaurantLocation,
  haversineKm,
  calculateDeliveryFee,
  effectiveDeliveryRadiusKm,
};

'use strict';

// ─────────────────────────────────────────────────────────────────────
// Central route-distance service.
//
// The SINGLE backend authority for distance used in money calculations.
// Nothing in the pricing engine trusts a client-supplied distance.
//
// Provider priority: Ola Maps Distance Matrix Basic (when OLA_MAPS_API_KEY is
// configured), then the existing Mapbox Directions integration. If neither
// provider returns a route, the service degrades to a conservative straight-line
// estimate inflated by ROAD_FACTOR. MapTiler/frontend map rendering is untouched.
//
// The straight-line fallback is intentionally CONSERVATIVE (it over-estimates
// rather than under-estimates road distance), because under-estimating would
// under-pay the rider and under-price the customer. Every result carries a
// `source` so the snapshot records whether the number was a real road route
// or an estimate, and a `degraded` flag the orchestrator can use for warnings.
// ─────────────────────────────────────────────────────────────────────

const { haversineKm, validCoordinates } = require('../deliveryPricing');

// Empirical urban-road inflation factor for a straight-line estimate. Indian
// city routes typically run 1.25-1.45x the great-circle distance; 1.3 is the
// conservative mid-point. This is a FALLBACK only, never the primary source.
const ROAD_FACTOR = 1.3;
// Average two-wheeler speed used for an ETA when the provider gives none.
const FALLBACK_SPEED_KMH = 22;

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/** A coordinate pair the service can actually use. */
function usable(coords) {
  if (!validCoordinates(coords)) return null;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  // (0,0) is the null island — a default, never a real delivery point.
  if (lng === 0 && lat === 0) return null;
  return [lng, lat];
}

/**
 * Straight-line estimate with the conservative road factor. Always available.
 */
function estimateRoute(from, to) {
  const straightKm = haversineKm(from, to);
  const distanceKm = round2(straightKm * ROAD_FACTOR);
  const durationSec = Math.round((distanceKm / FALLBACK_SPEED_KMH) * 3600);
  return { distanceKm, durationSec, source: 'haversine_estimate', degraded: true };
}

/**
 * Prefer Ola Maps for India-focused road distance. If Ola is unavailable or
 * returns no usable route, retain the existing Mapbox provider as a fallback.
 * If both fail, resolveRoute() uses the conservative Haversine estimate.
 */
async function getPreferredRoute(from, to, cacheKey) {
  const olaMaps = require('../olaMapsService');
  if (olaMaps.isConfigured()) {
    const olaRoute = await olaMaps.getRoute(from, to, cacheKey);
    if (olaRoute) return olaRoute;
  }

  const mapbox = require('../mapboxService');
  if (mapbox.isConfigured()) {
    const mapboxRoute = await mapbox.getRoute(from, to, cacheKey);
    if (mapboxRoute) return { ...mapboxRoute, source: 'mapbox_directions' };
  }
  return null;
}

/**
 * Resolve one road route between two points.
 *
 * @param {number[]} from [lng, lat]
 * @param {number[]} to   [lng, lat]
 * @param {object}   opts
 * @param {Function} opts.routeFn   injectable provider (tests/custom provider override)
 * @param {string}   opts.cacheKey  optional caller prefix; both endpoints are always
 *                                  appended so the key identifies the route
 * @returns {Promise<{distanceKm:number,durationSec:number,source:string,degraded:boolean}>}
 *          Never rejects: an unusable point or provider failure returns the
 *          straight-line estimate.
 */
async function resolveRoute(from, to, { routeFn = null, cacheKey = null } = {}) {
  const a = usable(from);
  const b = usable(to);
  if (!a || !b) {
    return { distanceKm: 0, durationSec: 0, source: 'unavailable', degraded: true };
  }

  const provider = routeFn || providerOverride || getPreferredRoute;
  try {
    // The provider caches by this key, so it MUST identify the route: a
    // caller prefix alone (`card:<restaurantId>|r2c`) would hand the next
    // customer the previous customer's distance. Always append both endpoints.
    const routeKey = `${a.join(',')}|${b.join(',')}`;
    const result = await provider(a, b, cacheKey ? `${cacheKey}|${routeKey}` : routeKey);
    if (result && Number.isFinite(Number(result.distanceMeters)) && Number(result.distanceMeters) > 0) {
      return {
        distanceKm: round2(Number(result.distanceMeters) / 1000),
        durationSec: Number.isFinite(Number(result.durationSec)) ? Math.round(Number(result.durationSec)) : 0,
        source: result.source || 'mapbox_directions',
        degraded: false,
      };
    }
  } catch (err) {
    console.error('[route] provider failed, using estimate:', err.message);
  }
  return estimateRoute(a, b);
}

/**
 * The three-distance model required by the pricing engine.
 *
 *   riderToRestaurant     — rider GPS -> restaurant pickup
 *   restaurantToCustomer  — restaurant pickup -> customer address
 *   repositioning         — post-delivery travel the rider must make when no
 *                           nearby follow-up order is available
 *
 * Repositioning is only charged when the caller states there is no next order
 * (`hasNextOrderNearby === false`). When a nearby follow-up exists the extra
 * travel is zero — a rider is never charged for a return they will not make.
 *
 * @returns {Promise<object>} distances in km plus ETA seconds and provenance
 */
async function resolveTripDistances({
  restaurantCoords,
  customerCoords,
  riderCoords = null,
  hasNextOrderNearby = false,
  routeFn = null,
  cacheKeyPrefix = '',
} = {}) {
  const restaurant = usable(restaurantCoords);
  const customer = usable(customerCoords);

  const result = {
    riderToRestaurantKm: null,
    restaurantToCustomerKm: null,
    repositioningKm: 0,
    riderToRestaurantSec: null,
    restaurantToCustomerSec: null,
    repositioningSec: 0,
    sources: { riderToRestaurant: null, restaurantToCustomer: null, repositioning: null },
    degraded: false,
    available: Boolean(restaurant && customer),
  };

  if (!restaurant || !customer) {
    // Without both endpoints no money can be computed. The caller must treat
    // `available:false` as NOT_SERVICEABLE rather than guessing.
    return result;
  }

  const prefix = cacheKeyPrefix ? `${cacheKeyPrefix}|` : '';
  const riderStart = usable(riderCoords);
  const [toCustomer, toRestaurant] = await Promise.all([
    resolveRoute(restaurant, customer, { routeFn, cacheKey: `${prefix}r2c` }),
    riderStart
      ? resolveRoute(riderStart, restaurant, { routeFn, cacheKey: `${prefix}p2r` })
      : Promise.resolve(null),
  ]);

  result.restaurantToCustomerKm = toCustomer.distanceKm;
  result.restaurantToCustomerSec = toCustomer.durationSec;
  result.sources.restaurantToCustomer = toCustomer.source;
  result.degraded = result.degraded || toCustomer.degraded;

  if (toRestaurant) {
    result.riderToRestaurantKm = toRestaurant.distanceKm;
    result.riderToRestaurantSec = toRestaurant.durationSec;
    result.sources.riderToRestaurant = toRestaurant.source;
    result.degraded = result.degraded || toRestaurant.degraded;
  }

  if (!hasNextOrderNearby) {
    // Conservative repositioning: assume the rider must travel back toward the
    // restaurant. Charged at the same road distance as the outbound leg.
    result.repositioningKm = result.restaurantToCustomerKm;
    result.repositioningSec = Math.round(result.restaurantToCustomerSec || 0);
    result.sources.repositioning = result.sources.restaurantToCustomer;
  }

  return result;
}

/** Test/dev helper: swap the provider for the whole process. */
let providerOverride = null;
function setRouteProvider(fn) { providerOverride = typeof fn === 'function' ? fn : null; }
function currentRouteProvider() { return providerOverride; }

/** Resolve using the process-wide provider override when one is set. */
async function resolveRouteWithOverride(from, to, opts = {}) {
  return resolveRoute(from, to, { routeFn: providerOverride, ...opts });
}

async function resolveTripDistancesWithOverride(args = {}) {
  return resolveTripDistances({ routeFn: providerOverride, ...args });
}

module.exports = {
  ROAD_FACTOR,
  FALLBACK_SPEED_KMH,
  estimateRoute,
  resolveRoute,
  resolveTripDistances,
  resolveRouteWithOverride,
  resolveTripDistancesWithOverride,
  setRouteProvider,
  currentRouteProvider,
};

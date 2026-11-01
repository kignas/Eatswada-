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
 * Detour sanity guard.
 *
 * A road route is never shorter than the straight line, and on Indian town
 * roads it is normally 1.2-1.6x. When a provider returns something far above
 * that (e.g. 7.0 km for a 3.3 km straight line = 2.1x) the customer is
 * charged a higher delivery band for a trip that is probably not that long.
 *
 * ROUTE_DETOUR_GUARD (env):
 *   off      - do nothing
 *   log      - DEFAULT. Log both providers' numbers when the ratio is exceeded,
 *              but keep using the primary route. Money is unchanged.
 *   enforce  - when the primary route exceeds the ratio, ask the secondary
 *              provider and use the LOWER of the two distances.
 * ROUTE_DETOUR_RATIO (env, default 1.8): max accepted road / straight-line.
 *
 * Pure function: callers inject the secondary provider so it can be tested.
 */
function detourSettings(env = process.env) {
  const raw = String(env.ROUTE_DETOUR_GUARD || 'log').trim().toLowerCase();
  const mode = ['off', 'log', 'enforce'].includes(raw) ? raw : 'log';
  const ratio = Number(env.ROUTE_DETOUR_RATIO);
  return { mode, ratio: Number.isFinite(ratio) && ratio >= 1.2 ? ratio : 1.8 };
}

async function applyDetourGuard({ from, to, primary, secondary, cacheKey, env = process.env, log = console }) {
  const { mode, ratio } = detourSettings(env);
  if (mode === 'off' || !primary) return primary;
  const straightKm = haversineKm(from, to);
  const primaryKm = Number(primary.distanceMeters) / 1000;
  // Very short hops are noisy (a 200 m straight line can be 600 m of road).
  if (!Number.isFinite(primaryKm) || straightKm < 0.5 || primaryKm <= straightKm * ratio) return primary;

  let alt = null;
  try { alt = secondary ? await secondary(from, to, cacheKey) : null; } catch (_) { alt = null; }
  const altKm = alt && Number(alt.distanceMeters) > 0 ? Number(alt.distanceMeters) / 1000 : null;
  log.warn('[route] detour guard: road distance looks too long', {
    mode, ratio, straightKm: round2(straightKm), primaryKm: round2(primaryKm),
    primarySource: primary.source || null, secondaryKm: altKm == null ? null : round2(altKm),
    secondarySource: alt ? (alt.source || 'mapbox_directions') : null,
  });
  if (mode === 'enforce' && altKm != null && altKm < primaryKm) {
    return { ...alt, source: alt.source || 'mapbox_directions', detourGuard: { replaced: primary.source || null, primaryKm: round2(primaryKm) } };
  }
  return primary;
}

/**
 * Prefer Ola Maps for India-focused road distance. If Ola is unavailable or
 * returns no usable route, retain the existing Mapbox provider as a fallback.
 * If both fail, resolveRoute() uses the conservative Haversine estimate.
 */
async function getPreferredRoute(from, to, cacheKey) {
  const olaMaps = require('../olaMapsService');
  const mapbox = require('../mapboxService');
  const mapboxRoute = (a, b, key) => mapbox.isConfigured()
    ? mapbox.getRoute(a, b, `mb|${key || ''}`).then(r => (r ? { ...r, source: 'mapbox_directions' } : null))
    : Promise.resolve(null);

  if (olaMaps.isConfigured()) {
    const olaRoute = await olaMaps.getRoute(from, to, cacheKey);
    if (olaRoute) return applyDetourGuard({ from, to, primary: olaRoute, secondary: mapboxRoute, cacheKey });
  }

  if (mapbox.isConfigured()) {
    const route = await mapbox.getRoute(from, to, cacheKey);
    if (route) return { ...route, source: 'mapbox_directions' };
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
  detourSettings,
  applyDetourGuard,
  resolveRoute,
  resolveTripDistances,
  resolveRouteWithOverride,
  resolveTripDistancesWithOverride,
  setRouteProvider,
  currentRouteProvider,
};

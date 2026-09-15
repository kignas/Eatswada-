'use strict';

/**
 * Mapbox Directions — road-based route + ETA between two points.
 *
 * The access token is read from process.env.MAPBOX_TOKEN and NEVER shipped to
 * the browser. Results are cached per order for a short TTL so we don't call
 * the Directions API on every 5-second poll — the rider marker still moves
 * every poll (from raw GPS), only the route line + ETA refresh each minute.
 *
 * Returns null when unconfigured or on any error, so callers transparently
 * fall back to the straight-line estimate.
 */

const axios = require('axios');

const TTL_MS = 60 * 1000;     // recompute a given order's route at most once/min
const cache = new Map();      // orderId (or coord key) -> { at, value }

function isConfigured() { return !!process.env.MAPBOX_TOKEN; }

async function getRoute(fromLngLat, toLngLat, cacheKey) {
  if (!isConfigured()) return null;
  if (!Array.isArray(fromLngLat) || fromLngLat.length < 2) return null;
  if (!Array.isArray(toLngLat) || toLngLat.length < 2) return null;

  const key = cacheKey || `${fromLngLat.join(',')}|${toLngLat.join(',')}`;
  const hit = cache.get(key);
  if (hit && (Date.now() - hit.at) < TTL_MS) return hit.value;

  try {
    const coords = `${fromLngLat[0]},${fromLngLat[1]};${toLngLat[0]},${toLngLat[1]}`;
    const resp = await axios.get(
      `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}`,
      {
        params: { geometries: 'geojson', overview: 'full', access_token: process.env.MAPBOX_TOKEN },
        timeout: 4000,
      }
    );
    const route = resp.data && resp.data.routes && resp.data.routes[0];
    const value = route ? {
      durationSec: route.duration,
      distanceMeters: route.distance,
      geometry: (route.geometry && route.geometry.coordinates) || [],  // [ [lng,lat], ... ]
    } : null;
    cache.set(key, { at: Date.now(), value });

    if (cache.size > 500) {                       // guard against unbounded growth
      const cutoff = Date.now() - TTL_MS;
      for (const [k, v] of cache) if (v.at < cutoff) cache.delete(k);
    }
    return value;
  } catch (err) {
    cache.set(key, { at: Date.now(), value: null });  // brief negative cache
    return null;
  }
}

module.exports = { getRoute, isConfigured };

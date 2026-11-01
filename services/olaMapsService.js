'use strict';

/**
 * Ola Maps Directions adapter for Eatswada delivery distances.
 * Uses bike mode (two-wheeler equivalent) rather than Distance Matrix Basic,
 * which does not expose a travel-mode option. Coordinates are stored as
 * [longitude, latitude] and sent to Ola as lat,lng.
 * API key remains server-side only.
 */
const axios = require('axios');

const API_URL = 'https://api.olamaps.io/routing/v1/directions';
const TTL_MS = 60 * 1000;
const NEGATIVE_TTL_MS = 5 * 1000;
const REQUEST_TIMEOUT_MS = 6500;
const cache = new Map();

function isConfigured() {
  return Boolean(String(process.env.OLA_MAPS_API_KEY || '').trim());
}

function toLatLng(coords) {
  return `${Number(coords[1])},${Number(coords[0])}`;
}

function extractRoute(data) {
  const route = data?.routes?.[0];
  const legs = Array.isArray(route?.legs) ? route.legs : [];
  const distanceMeters = legs.length
    ? legs.reduce((sum, leg) => sum + Number(leg?.distance || 0), 0)
    : Number(route?.distance || route?.legs?.[0]?.distance);
  const durationSec = legs.length
    ? legs.reduce((sum, leg) => sum + Number(leg?.duration || 0), 0)
    : Number(route?.duration || route?.legs?.[0]?.duration);
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0 ||
      !Number.isFinite(durationSec) || durationSec < 0) return null;
  return { distanceMeters, durationSec };
}

async function getRoute(fromLngLat, toLngLat, cacheKey) {
  if (!isConfigured()) return null;
  if (!Array.isArray(fromLngLat) || fromLngLat.length < 2 ||
      !Array.isArray(toLngLat) || toLngLat.length < 2) return null;

  const key = cacheKey || `${fromLngLat.join(',')}|${toLngLat.join(',')}|bike`;
  const hit = cache.get(key);
  if (hit && (Date.now() - hit.at) < (hit.value ? TTL_MS : NEGATIVE_TTL_MS)) return hit.value;

  try {
    const origin = toLatLng(fromLngLat);
    const destination = toLatLng(toLngLat);
    const response = await axios.post(API_URL, null, {
      params: {
        origin,
        destination,
        mode: 'bike',
        route_preference: 'fastest',
        alternatives: false,
        steps: false,
        overview: 'false',
        api_key: String(process.env.OLA_MAPS_API_KEY).trim(),
      },
      timeout: REQUEST_TIMEOUT_MS,
    });
    const parsed = extractRoute(response?.data);
    if (!parsed) {
      cache.set(key, { at: Date.now(), value: null });
      if (process.env.ROUTE_DIAGNOSTICS === 'true') {
        console.warn('[route] Ola bike directions returned no usable route', {
          origin, destination, status: response?.data?.status || 'unknown',
        });
      }
      return null;
    }

    const value = {
      ...parsed,
      geometry: [],
      source: 'ola_maps_directions_bike',
    };
    cache.set(key, { at: Date.now(), value });
    if (process.env.ROUTE_DIAGNOSTICS === 'true') {
      console.info('[route] Ola bike route resolved', {
        origin, destination, distanceMeters: parsed.distanceMeters,
        durationSec: parsed.durationSec, source: value.source,
      });
    }
    if (cache.size > 500) {
      const cutoff = Date.now() - TTL_MS;
      for (const [entryKey, entry] of cache) if (entry.at < cutoff) cache.delete(entryKey);
    }
    return value;
  } catch (error) {
    // Never log Axios config: its query parameters contain the API key.
    if (process.env.ROUTE_DIAGNOSTICS === 'true') {
      console.warn('[route] Ola bike directions request failed', {
        status: error?.response?.status || null,
        message: error?.response?.data?.message || error.message,
      });
    }
    cache.set(key, { at: Date.now(), value: null });
    return null;
  }
}

module.exports = { getRoute, isConfigured };

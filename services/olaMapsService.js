'use strict';

/**
 * Ola Maps Distance Matrix Basic adapter.
 *
 * Uses the server-side API key (never expose it to the browser). The API
 * accepts coordinates as lat,lng, while Eatswada stores/routes coordinates
 * as [lng, lat]. This adapter performs that conversion at the boundary.
 *
 * OAuth credentials are not required for this API-key authentication path.
 * They may remain configured in AWS for future OAuth-only endpoints.
 */

const axios = require('axios');

const API_URL = 'https://api.olamaps.io/routing/v1/distanceMatrix/basic';
const TTL_MS = 60 * 1000;
const NEGATIVE_TTL_MS = 5 * 1000;
const REQUEST_TIMEOUT_MS = 4500;
const cache = new Map();

function isConfigured() {
  return Boolean(String(process.env.OLA_MAPS_API_KEY || '').trim());
}

function toLatLng(coords) {
  return `${Number(coords[1])},${Number(coords[0])}`;
}

async function getRoute(fromLngLat, toLngLat, cacheKey) {
  if (!isConfigured()) return null;
  if (!Array.isArray(fromLngLat) || fromLngLat.length < 2 ||
      !Array.isArray(toLngLat) || toLngLat.length < 2) return null;

  const key = cacheKey || `${fromLngLat.join(',')}|${toLngLat.join(',')}`;
  const hit = cache.get(key);
  if (hit && (Date.now() - hit.at) < (hit.value ? TTL_MS : NEGATIVE_TTL_MS)) {
    return hit.value;
  }

  try {
    const response = await axios.get(API_URL, {
      params: {
        origins: toLatLng(fromLngLat),
        destinations: toLatLng(toLngLat),
        route_preference: 'fastest',
        api_key: String(process.env.OLA_MAPS_API_KEY).trim(),
      },
      timeout: REQUEST_TIMEOUT_MS,
    });

    const element = response?.data?.rows?.[0]?.elements?.[0];
    const status = String(element?.status || '').toUpperCase();
    const distanceMeters = Number(element?.distance);
    const durationSec = Number(element?.duration);

    if ((status && status !== 'OK') ||
        !Number.isFinite(distanceMeters) || distanceMeters <= 0 ||
        !Number.isFinite(durationSec) || durationSec < 0) {
      cache.set(key, { at: Date.now(), value: null });
      return null;
    }

    const value = {
      distanceMeters,
      durationSec,
      geometry: [],
      source: 'ola_maps_distance_matrix_basic',
    };
    cache.set(key, { at: Date.now(), value });

    if (cache.size > 500) {
      const cutoff = Date.now() - TTL_MS;
      for (const [cacheKeyEntry, entry] of cache) {
        if (entry.at < cutoff) cache.delete(cacheKeyEntry);
      }
    }
    return value;
  } catch (error) {
    // Do not log request config: it contains the API key in query parameters.
    cache.set(key, { at: Date.now(), value: null });
    return null;
  }
}

module.exports = { getRoute, isConfigured };

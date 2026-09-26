'use strict';

/**
 * Tiny in-process cache for small, PUBLIC, rarely-changing read results
 * (homepage categories, homepage banners). No Redis, no dependency.
 *
 *  • TTL: a stored result is reused until it expires. ttlMs <= 0 disables the
 *    cache completely — every call runs the loader, exactly as if this module
 *    were not there (kill switch via env var, no code change needed).
 *  • Single-flight: callers that arrive while a load is running share it, so a
 *    burst of identical requests costs ONE database query, not one each.
 *  • Invalidation: invalidate() drops every stored result immediately. A load
 *    that was already running when invalidate() was called still answers the
 *    callers waiting on it, but its (possibly pre-write) result is never
 *    stored — the next call reloads.
 *  • Failures are never cached; the next call retries.
 *
 * Scope: one Node process. Writes made through this process invalidate
 * instantly; writes made elsewhere (another instance, a direct DB edit, the
 * seeder) become visible within the TTL.
 */

function readTtlMs(envName, fallbackMs) {
  const raw = process.env[envName];
  if (raw === undefined || String(raw).trim() === '') return fallbackMs;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallbackMs;
}

function createMemoryCache({ ttlMs }) {
  const entries = new Map();   // key -> { value, expiresAt }
  const inFlight = new Map();  // key -> Promise
  let generation = 0;

  const enabled = Number(ttlMs) > 0;

  function get(key, loader) {
    if (!enabled) return Promise.resolve().then(loader);

    const hit = entries.get(key);
    if (hit && Date.now() < hit.expiresAt) return Promise.resolve(hit.value);
    if (hit) entries.delete(key);

    const pending = inFlight.get(key);
    if (pending) return pending;

    const startedGeneration = generation;
    const load = Promise.resolve()
      .then(loader)
      .then((value) => {
        if (startedGeneration === generation) {
          entries.set(key, { value, expiresAt: Date.now() + ttlMs });
        }
        return value;
      })
      .finally(() => {
        if (inFlight.get(key) === load) inFlight.delete(key);
      });

    inFlight.set(key, load);
    return load;
  }

  function invalidate() {
    generation += 1;
    entries.clear();
    inFlight.clear();
  }

  return { get, invalidate, enabled, ttlMs };
}

module.exports = { createMemoryCache, readTtlMs };

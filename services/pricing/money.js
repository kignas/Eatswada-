'use strict';

// ─────────────────────────────────────────────────────────────────────
// Integer-paise money helpers — the SINGLE rounding authority for the
// dynamic pricing engine.
//
// Every financial value inside services/pricing/ is carried as an integer
// number of paise. Rupee values only appear at the API boundary (converted
// with fromPaise). No binary floating-point arithmetic is used to decide a
// settlement amount, so 0.1 + 0.2 style drift can never change a payout.
//
// Rounding policy: half-up on the absolute value, applied exactly once at
// the point a fractional amount is created (a percentage, a rate times a
// distance, an allocation). Values that are already integral paise are never
// re-rounded.
// ─────────────────────────────────────────────────────────────────────

/** Rupees (number, may be fractional) -> integer paise. */
function toPaise(rupees) {
  const n = Number(rupees);
  if (!Number.isFinite(n)) return 0;
  return roundHalfUp(n * 100);
}

/** Integer paise -> rupees rounded to 2 dp (for API responses only). */
function fromPaise(paise) {
  const n = Number(paise);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

/** Half-up rounding of a possibly-fractional number to an integer. */
function roundHalfUp(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

/** Half-up percentage of an integer-paise base. */
function percentOfPaise(basePaise, percent) {
  const p = Number(percent);
  const base = roundHalfUp(basePaise);
  if (!Number.isFinite(p) || p === 0) return 0;
  return roundHalfUp((base * p) / 100);
}

/**
 * Largest-remainder allocation of `totalPaise` across `weights`.
 * The returned integers sum EXACTLY to totalPaise. Used to split a
 * multi-restaurant discount or a shared fee so no paisa is invented or lost.
 */
function allocatePaise(totalPaise, weights) {
  const list = Array.isArray(weights) ? weights.map(w => Math.max(0, Number(w) || 0)) : [];
  const n = list.length;
  if (n === 0) return [];

  const total = roundHalfUp(totalPaise);
  const sum = list.reduce((a, b) => a + b, 0);
  const effective = sum > 0 ? list : new Array(n).fill(1);
  const effectiveSum = effective.reduce((a, b) => a + b, 0);

  const exact = effective.map(w => (total * w) / effectiveSum);
  const floors = exact.map(Math.floor);
  const remainder = total - floors.reduce((a, b) => a + b, 0);

  const byFraction = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => (b.frac - a.frac) || (a.index - b.index));

  const result = floors.slice();
  for (let k = 0; k < remainder; k += 1) result[byFraction[k].index] += 1;
  return result;
}

/** Clamp an integer-paise value to a [min, max] window (inclusive). */
function clampPaise(value, minPaise, maxPaise) {
  const v = roundHalfUp(value);
  const lo = roundHalfUp(minPaise);
  const hi = roundHalfUp(maxPaise);
  return Math.min(Math.max(v, lo), hi);
}

/** Non-negative integer paise, or 0 for junk input. */
function nonNegativePaise(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return roundHalfUp(n);
}

module.exports = {
  toPaise,
  fromPaise,
  roundHalfUp,
  percentOfPaise,
  allocatePaise,
  clampPaise,
  nonNegativePaise,
};

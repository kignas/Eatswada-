'use strict';

// ─────────────────────────────────────────────────────────────────────
// Pure, dependency-free checkout math for multi-restaurant checkout.
//
// Nothing in here trusts the client for pricing or ownership: it operates
// on a menu→restaurant map that the caller builds from MongoDB, and on
// delivery fees that the caller has already computed server-side. Keeping
// it pure makes the security-critical parts (grouping, tip allocation)
// unit-testable without a database.
// ─────────────────────────────────────────────────────────────────────

/**
 * The many shapes a cart line can arrive in. The authoritative id is the
 * referenced Menu document id — never a client-supplied restaurantId.
 */
function getMenuRefId(item) {
  return item?.menuItem || item?.menuId || item?.id || item?._id;
}

/**
 * Group requested cart items by the REAL restaurant that owns each menu
 * item, using a map the caller resolved from MongoDB
 * (menuIdString -> restaurantIdString). The client's restaurantId is
 * ignored on purpose — this is what stops a client putting one
 * restaurant's item under another's order.
 *
 * Returns an array of { restaurantId, items } in first-seen order so the
 * behaviour is deterministic. Throws (with .statusCode) if any item's menu
 * id is missing from the map — we never silently guess an owner.
 */
function groupItemsByRestaurant(items, menuRestaurantMap) {
  if (!Array.isArray(items) || items.length === 0) {
    const error = new Error('Cart is empty');
    error.statusCode = 400;
    throw error;
  }

  const order = [];
  const groups = new Map();

  for (const item of items) {
    const menuId = getMenuRefId(item);
    const restaurantId = menuId != null ? menuRestaurantMap.get(String(menuId)) : undefined;

    if (!restaurantId) {
      const error = new Error('One or more cart items are invalid or outdated. Please refresh your cart.');
      error.statusCode = 400;
      throw error;
    }

    const key = String(restaurantId);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(item);
  }

  return order.map(restaurantId => ({ restaurantId, items: groups.get(restaurantId) }));
}

/**
 * Round a rupee value to 2 dp without binary-float drift.
 */
function roundCurrency(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Deterministic tip-allocation policy for a multi-restaurant checkout.
 *
 * A customer-selected tip must be split across the child orders — it must
 * NOT be duplicated onto every restaurant's order. Policy:
 *   - allocate proportionally to each order's verified delivery fee;
 *   - if every delivery fee is 0, split equally;
 *   - work in integer paise (cents) and use the largest-remainder method
 *     so the allocated amounts sum EXACTLY to the requested tip, never a
 *     rupee more or less;
 *   - each returned amount is rounded to 2 dp.
 *
 * The frontend never controls this allocation.
 *
 * @param {number} requestedTip   validated, non-negative rupee tip
 * @param {number[]} deliveryFees per-order verified delivery fees (same order as the result)
 * @returns {number[]} per-order tip amounts, summing exactly to requestedTip
 */
function allocateTip(requestedTip, deliveryFees) {
  const n = Array.isArray(deliveryFees) ? deliveryFees.length : 0;
  if (n === 0) return [];

  const tipPaise = Math.round(Number(requestedTip) * 100);
  if (!Number.isFinite(tipPaise) || tipPaise <= 0) {
    return new Array(n).fill(0);
  }

  const feePaise = deliveryFees.map(fee => Math.max(0, Math.round(Number(fee) * 100)));
  const totalFee = feePaise.reduce((sum, fee) => sum + fee, 0);

  // Proportional by delivery fee, or equal split when all fees are zero.
  const weights = totalFee > 0 ? feePaise : new Array(n).fill(1);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  const exact = weights.map(w => (tipPaise * w) / totalWeight);
  const floors = exact.map(Math.floor);
  const allocated = floors.reduce((sum, v) => sum + v, 0);
  let remainder = tipPaise - allocated; // 0 .. n-1 paise still to hand out

  // Largest-remainder method: give the leftover paise to the entries with
  // the biggest fractional parts (ties broken by index for determinism).
  const byFraction = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => (b.frac - a.frac) || (a.index - b.index));

  const resultPaise = floors.slice();
  for (let k = 0; k < remainder; k += 1) {
    resultPaise[byFraction[k].index] += 1;
  }

  return resultPaise.map(paise => roundCurrency(paise / 100));
}

/**
 * Resolve the restaurant-specific note for one restaurant in a checkout.
 *
 * A note is NEVER blindly copied into every restaurant's order. Precedence:
 *   1. a per-restaurant note from the validated restaurantNotes list;
 *   2. otherwise, for a SINGLE-restaurant checkout, the legacy flat
 *      restaurantNote (preserves existing single-restaurant behaviour);
 *   3. otherwise, for a multi-restaurant checkout, the flat restaurantNote
 *      ONLY when the customer explicitly marked it global (globalNote=true);
 *   4. otherwise empty.
 *
 * All notes are trimmed and hard-capped at 250 chars.
 */
function resolveRestaurantNote({ restaurantId, perRestaurantNotes, flatNote, isSingleRestaurant, globalNote }) {
  const cap = raw => (typeof raw === 'string' ? raw.trim().slice(0, 250) : '');

  if (perRestaurantNotes && Object.prototype.hasOwnProperty.call(perRestaurantNotes, String(restaurantId))) {
    return cap(perRestaurantNotes[String(restaurantId)]);
  }
  if (isSingleRestaurant) {
    return cap(flatNote);
  }
  if (globalNote === true) {
    return cap(flatNote);
  }
  return '';
}

/**
 * Validate + normalise a client-supplied restaurantNotes payload into a
 * plain { [restaurantId]: note } map. Accepts either an array of
 * { restaurantId, note } or a plain object keyed by restaurantId. Invalid
 * shapes are ignored rather than trusted. isValidObjectId is injected so
 * this module stays free of a mongoose dependency.
 */
function normalizeRestaurantNotes(input, isValidObjectId) {
  const out = {};
  if (!input) return out;

  const entries = Array.isArray(input)
    ? input.map(entry => [entry?.restaurantId, entry?.note])
    : (typeof input === 'object' ? Object.entries(input) : []);

  for (const [rid, note] of entries) {
    if (rid == null) continue;
    const key = String(rid);
    if (typeof isValidObjectId === 'function' && !isValidObjectId(key)) continue;
    if (typeof note !== 'string') continue;
    out[key] = note.trim().slice(0, 250);
  }
  return out;
}

module.exports = {
  getMenuRefId,
  groupItemsByRestaurant,
  allocateTip,
  roundCurrency,
  resolveRestaurantNote,
  normalizeRestaurantNotes,
};

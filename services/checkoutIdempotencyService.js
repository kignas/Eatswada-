'use strict';

const crypto = require('crypto');

/**
 * Duplicate-checkout protection for createOrder.
 *
 * A client MAY send an Idempotency-Key (header or body.idempotencyKey); that path is
 * unchanged. When it does not (double-tap, older app build), the server derives a
 * key from the user and everything that defines the checkout: cart, address,
 * payment method, tip, coupon, notes, cutlery. Two identical checkouts from the same
 * user inside a short window are treated as one.
 *
 * Derived keys carry a time window instead of living forever: a customer may
 * legitimately re-order the same cart later. The window is enforced two ways:
 *  - replayFilter() only replays orders created inside the window, and
 *  - claimCheckoutLock() lets a request take over a derived lock older than the
 *    window with one atomic conditional update, so overlapping requests that arrive
 *    right after expiry still produce exactly one winner.
 * No Redis: the unique _id of the IdempotencyKey collection is the atomic guarantee.
 */

const DEFAULT_WINDOW_SECONDS = 30;
const MIN_WINDOW_SECONDS = 5;
const DERIVED_PREFIX = 'srv:';

function dedupeWindowMs() {
  const s = Number(process.env.CHECKOUT_DEDUPE_WINDOW_SECONDS);
  return (Number.isFinite(s) && s >= MIN_WINDOW_SECONDS ? s : DEFAULT_WINDOW_SECONDS) * 1000;
}

// JSON with object keys sorted, so property order never changes the fingerprint.
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function deriveCheckoutKey(userId, body = {}) {
  const items = (Array.isArray(body.items) ? body.items : []).map(stable).sort();
  const fingerprint = stable({
    user: String(userId),
    items,
    addressId: body.addressId || '',
    deliveryAddress: body.deliveryAddress || null,
    paymentMethod: String(body.paymentMethod || 'upi').toLowerCase(),
    tipAmount: Number(body.tipAmount || 0),
    couponCode: String(body.couponCode || '').trim().toUpperCase(),
    restaurantNote: body.restaurantNote ?? null,
    restaurantNotes: body.restaurantNotes ?? null,
    globalNote: body.globalNote ?? null,
    deliveryInstructions: body.deliveryInstructions ?? null,
    sendCutlery: Boolean(body.sendCutlery),
  });
  return DERIVED_PREFIX + crypto.createHash('sha256').update(fingerprint).digest('hex');
}

/** { key, derived } — the client's key when sent, otherwise a server-derived one. */
function resolveCheckoutKey(userId, req) {
  const clientKey = String((req.headers && req.headers['idempotency-key']) || (req.body && req.body.idempotencyKey) || '')
    .trim().slice(0, 100);
  if (clientKey) return { key: clientKey, derived: false };
  return { key: deriveCheckoutKey(userId, req.body || {}), derived: true };
}

/** Order.find filter for "orders already created for this checkout". */
function replayFilter(userId, { key, derived }, now = Date.now(), windowMs = dedupeWindowMs()) {
  const filter = { user: userId, idempotencyKey: key };
  if (derived) filter.createdAt = { $gte: new Date(now - windowMs) };
  return filter;
}

/**
 * Claim the checkout lock. true = this request may create the orders; false = another
 * request owns this checkout (caller replays its orders or answers 409).
 */
async function claimCheckoutLock(IdempotencyKey, { userId, key, derived }, now = Date.now(), windowMs = dedupeWindowMs()) {
  const lockId = `${userId}:${key}`;
  try {
    await IdempotencyKey.create({ _id: lockId, user: userId, key });
    return true;
  } catch (err) {
    if (!(err && err.code === 11000)) throw err;
  }
  if (!derived) return false; // client-supplied keys never expire by age (24h TTL only)
  const taken = await IdempotencyKey.findOneAndUpdate(
    { _id: lockId, createdAt: { $lt: new Date(now - windowMs) } },
    { $set: { createdAt: new Date(now) } },
  );
  return Boolean(taken);
}

module.exports = { resolveCheckoutKey, deriveCheckoutKey, replayFilter, claimCheckoutLock, dedupeWindowMs };

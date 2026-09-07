const mongoose = require('mongoose');

// ── Atomic idempotency lock ─────────────────────────────────────────────
// One document per checkout attempt, keyed by `${userId}:${idempotencyKey}`.
//
// Its UNIQUE _id is what makes duplicate-order prevention atomic. MongoDB
// always enforces uniqueness on _id, so two truly-simultaneous checkout POSTs
// that race to insert the same _id can never both succeed — exactly one wins
// and the other receives a duplicate-key error (E11000). createOrder uses that
// to guarantee only ONE request ever creates the order set.
//
// This is separate from the order-replay read in createOrder (which matches on
// Order.idempotencyKey and handles ordinary SEQUENTIAL retries). We deliberately
// did NOT make the Order (user, idempotencyKey) index unique, because:
//   • a multi-restaurant checkout intentionally writes several Order docs that
//     SHARE one key, and
//   • orders placed without a key all share idempotencyKey === '' by default.
// A unique index there would reject both of those legitimate cases. Isolating
// the uniqueness in this tiny collection avoids that entirely.
const idempotencyKeySchema = new mongoose.Schema(
  {
    _id:  { type: String }, // `${userId}:${idempotencyKey}`
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    key:  { type: String, required: true },
    // TTL housekeeping only. Once orders exist, the order-replay read serves
    // retries; once a failed checkout releases its lock, the doc is gone. Any
    // survivors are stale and self-expire so this collection can't grow forever.
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// Self-expire stale locks 24h after creation.
idempotencyKeySchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports =
  mongoose.models.IdempotencyKey ||
  mongoose.model('IdempotencyKey', idempotencyKeySchema);

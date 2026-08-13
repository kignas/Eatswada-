const mongoose = require('mongoose');
const crypto   = require('crypto');

// ── Delivery OTP config ──────────────────────────────────────────
// The 4-digit code matches the /^\d{4}$/ check in riderController's
// verifyDeliveryOtp, and the field names (Hash/Salt/ExpiresAt/Attempts/
// LockedUntil) match the '+select' list used there — keep both in sync
// if any of this changes.
const OTP_TTL_MS      = 3 * 60 * 60 * 1000; // 3h — must outlive the whole placed→out_for_delivery journey
const MAX_OTP_ATTEMPTS = 5;
const OTP_LOCKOUT_MS   = 15 * 60 * 1000;    // 15 min lockout after too many wrong attempts

function generateOtpCode() {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4-digit
}

function hashOtp(code, salt) {
  return crypto.createHash('sha256').update(`${code}:${salt}`).digest('hex');
}

const orderItemSchema = new mongoose.Schema({
  // FIX: models/Menu.js registers its model as `mongoose.model('Menu', ...)`,
  // not 'MenuItem'. With the old ref, `.populate('items.menuItem')` would
  // throw MissingSchemaError the moment anything tried to use it — which is
  // exactly why the current menu item image could never be looked up live.
  menuItem:  { type: mongoose.Schema.Types.ObjectId, ref: 'Menu' },
  name:      { type: String, required: true },
  price:     { type: Number, required: true },
  image:     { type: String, default: '' },
  isVeg:     { type: Boolean, default: true },
  quantity:  { type: Number, required: true, min: 1 },
  customizations: { type: Object, default: {} },
}, { _id: false });

const statusEventSchema = new mongoose.Schema({
  status:    { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  note:      { type: String, default: '' },
}, { _id: false });

// ── Sequential public IDs ─────────────────────────────────────────
// Separate from MongoDB's _id. Counters are incremented atomically so
// simultaneous orders cannot receive the same public ID.
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, required: true, default: 0 },
});

const OrderCounter =
  mongoose.models.OrderCounter ||
  mongoose.model('OrderCounter', counterSchema);

const orderSchema = new mongoose.Schema(
  {
    // Public customer-facing order ID, e.g. NB100001.
    orderNumber: {
      type: String,
      unique: true,
      index: true,
    },

    // Public delivery/shipment ID, e.g. SH500001.
    shipmentId: {
      type: String,
      unique: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
    },
    restaurantName: { type: String, required: true },
    restaurantImage: { type: String, default: '' },

    // Customer contact snapshot. These are captured at order creation so
    // historical orders still have the customer's name/phone even if the
    // profile changes later. Populated `user` remains the source for older
    // orders that were created before these fields existed.
    customerName:  { type: String, default: '' },
    customerPhone: { type: String, default: '' },

    items: [orderItemSchema],

    // Address snapshot (do NOT ref — address can be deleted later)
    deliveryAddress: {
      tag:      String,
      house:    String,
      area:     String,
      landmark: String,
      city:     String,
      pincode:  String,
      // GeoJSON coordinates snapshot: [longitude, latitude].
      // Stored with the order so later address edits cannot change the
      // distance/fee of an already-created order.
      coordinates: {
        type: [Number],
        default: undefined,
      },
    },

    // Server-calculated delivery distance at order creation.
    deliveryDistanceKm: {
      type: Number,
      default: null,
      min: 0,
    },

    // Pricing — all values are calculated server-side at order creation.
    subtotal:    { type: Number, required: true },
    deliveryFee: { type: Number, default: 35, min: 0 },
    platformFee: { type: Number, default: 5 },
    discount:    { type: Number, default: 0 },
    total:       { type: Number, required: true },

    paymentMethod: {
      type: String,
      enum: ['upi', 'card', 'cod', 'wallet'],
      default: 'upi',
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    razorpayOrderId:   { type: String, default: '' },
    razorpayPaymentId: { type: String, default: '' },

    // ORDER LIFECYCLE — mirrors track-order.html progress bar
    status: {
      type: String,
      enum: [
        'placed',            // order placed, awaiting restaurant confirm
        'confirmed',         // restaurant accepted
        'preparing',         // kitchen is cooking
        'waiting_for_rider', // preparing done, looking for a rider
        'assigned',          // rider accepted the delivery
        'out_for_delivery',  // on the way
        'otp_verified',      // rider confirmed the customer's delivery PIN
        'delivered',         // completed
        'cancelled',         // cancelled by user / restaurant
      ],
      default: 'placed',
      index: true,
    },
    statusHistory: [statusEventSchema],

    estimatedDelivery: { type: Date },
    deliveredAt:       { type: Date },
    cancelReason:      { type: String, default: '' },
    isCancellable: {
      type: Boolean,
      default: true,   // becomes false once 'preparing' or beyond
    },
    rating: {
      score:   { type: Number, min: 1, max: 5 },
      comment: { type: String, maxlength: 400 },
      givenAt: Date,
    },

    // --- RIDER INTEGRATION ---
    rider: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    riderAssignedAt: {
      type: Date,
      default: null,
    },
    riderStatus: {
      type: String,
      enum: ['unassigned', 'assigned', 'accepted', 'reached_restaurant', 'picked_up', 'out_for_delivery', 'delivered'],
      default: 'unassigned',
    },
    riderStatusHistory: [
      {
        status: String,
        note: String,
        at: { type: Date, default: Date.now },
      },
    ],
    riderEarning: {
      type: Number,
      default: 0,
    },

    // --- DELIVERY OTP (customer hands this to the rider at the door) ---
    // deliveryOtp is the plaintext copy the customer's own order endpoints
    // return (see getOrders/getOrderById in orderController.js) so the
    // tracking page can show the same PIN on every visit, not just at
    // creation. deliveryOtpHash/Salt are the separate copy the rider-side
    // verifyDeliveryOtp() checks against — kept intentionally distinct so
    // a compromised admin/vendor/rider query (default select) never
    // surfaces either the hash or the plaintext by accident.
    deliveryOtp:            { type: String, select: false },
    deliveryOtpHash:       { type: String, select: false },
    deliveryOtpSalt:       { type: String, select: false },
    deliveryOtpExpiresAt:  { type: Date,   select: false },
    deliveryOtpAttempts:   { type: Number, default: 0, select: false },
    deliveryOtpLockedUntil:{ type: Date,   select: false },
    // NOT select:false — orderController/riderController read this straight
    // off normally-fetched documents (no '+' select) to gate "delivered".
    deliveryOtpVerified:   { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Rider integration compound index
orderSchema.index({ rider: 1, riderStatus: 1 });
orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ restaurant: 1, status: 1 });

/* ── Pre-save: generate order number ── */
orderSchema.pre('save', async function (next) {
  if (this.isNew) {
    // Atomic counters prevent duplicate public IDs when two orders arrive together.
    const orderCounter = await OrderCounter.findOneAndUpdate(
      { _id: 'orderNumber' },
      { $inc: { seq: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const shipmentCounter = await OrderCounter.findOneAndUpdate(
      { _id: 'shipmentId' },
      { $inc: { seq: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    this.orderNumber = `NB${100000 + orderCounter.seq}`;
    this.shipmentId = `SH${500000 + shipmentCounter.seq}`;

    // Push initial status event
    this.statusHistory.push({ status: 'placed', note: 'Order placed by customer' });

    // Estimated delivery: 40 mins from now
    this.estimatedDelivery = new Date(Date.now() + 40 * 60 * 1000);

    // Delivery OTP: generated once, shown to the customer on the tracking
    // page, and checked against the rider's entry at handoff. Only the
    // salted hash is persisted; the plaintext lives on `_plainDeliveryOtp`
    // (a plain, non-schema property — never saved to Mongo) just long
    // enough for the create-order controller to hand it back once.
    const plainOtp = generateOtpCode();
    const salt = crypto.randomBytes(16).toString('hex');
    this.deliveryOtp = plainOtp;
    this.deliveryOtpSalt = salt;
    this.deliveryOtpHash = hashOtp(plainOtp, salt);
    this.deliveryOtpExpiresAt = new Date(Date.now() + OTP_TTL_MS);
    this.deliveryOtpAttempts = 0;
    this.deliveryOtpLockedUntil = null;
    this.deliveryOtpVerified = false;
    this._plainDeliveryOtp = plainOtp;
  }
  next();
});

/* ── Instance method: advance status ── */
orderSchema.methods.advanceStatus = function (newStatus, note = '') {
  const NON_CANCELLABLE = ['preparing', 'out_for_delivery', 'delivered'];
  this.status = newStatus;
  this.statusHistory.push({ status: newStatus, note });
  if (NON_CANCELLABLE.includes(newStatus)) this.isCancellable = false;
  if (newStatus === 'delivered') this.deliveredAt = new Date();
  return this;
};

/* ── Instance method: verify the rider-entered delivery OTP ──
 * Must be called on a document fetched with the '+deliveryOtp*' fields
 * selected (see riderController.verifyDeliveryOtp). Mutates attempt/lock
 * state on `this` but does NOT save — the caller decides when to persist.
 */
orderSchema.methods.verifyDeliveryOtp = function (enteredOtp) {
  const now = new Date();

  if (this.deliveryOtpLockedUntil && this.deliveryOtpLockedUntil > now) {
    return { ok: false, reason: 'locked', lockedUntil: this.deliveryOtpLockedUntil };
  }

  if (!this.deliveryOtpHash || !this.deliveryOtpSalt) {
    return { ok: false, reason: 'not_set' };
  }

  if (this.deliveryOtpExpiresAt && this.deliveryOtpExpiresAt < now) {
    return { ok: false, reason: 'expired' };
  }

  const receivedOtp   = String(enteredOtp).trim();
  const receivedHash  = hashOtp(receivedOtp, this.deliveryOtpSalt);
  const isMatch       = receivedHash === this.deliveryOtpHash;

  // Debug trace requested during the "Incorrect PIN" investigation.
  // Never logs the plaintext stored OTP (it isn't persisted anywhere —
  // only its hash is) — logs the two hashes being compared instead, so a
  // mismatch is still fully diagnosable (wrong order, stale salt, expiry,
  // whitespace, etc.) without exposing the secret in logs.
  console.log(
    `[verifyDeliveryOtp] order=${this._id} status=${this.status} ` +
    `receivedOtp="${receivedOtp}" storedHash=${this.deliveryOtpHash} ` +
    `receivedHash=${receivedHash} match=${isMatch}`
  );

  if (isMatch) {
    this.deliveryOtpVerified = true;
    return { ok: true };
  }

  this.deliveryOtpAttempts = (this.deliveryOtpAttempts || 0) + 1;

  if (this.deliveryOtpAttempts >= MAX_OTP_ATTEMPTS) {
    this.deliveryOtpLockedUntil = new Date(Date.now() + OTP_LOCKOUT_MS);
    return { ok: false, reason: 'locked_now', lockedUntil: this.deliveryOtpLockedUntil };
  }

  return {
    ok: false,
    reason: 'incorrect',
    attemptsRemaining: MAX_OTP_ATTEMPTS - this.deliveryOtpAttempts,
  };
};

/* ── Instance method: strip OTP secrets before a document goes in a response ──
 * select:false keeps these out of *queries* by default, but any doc that
 * explicitly '+selected' them (as verifyDeliveryOtp's lookup does) still
 * carries them in memory. Call this right before res.json(...) whenever
 * such a document — or a freshly-created one, which always has them — is
 * about to be sent back.
 */
orderSchema.methods.clearOtpSecrets = function () {
  this.deliveryOtpHash = undefined;
  this.deliveryOtpSalt = undefined;
  this.deliveryOtpExpiresAt = undefined;
  this.deliveryOtpAttempts = undefined;
  this.deliveryOtpLockedUntil = undefined;
  this._plainDeliveryOtp = undefined;
  return this;
};

module.exports = mongoose.model('Order', orderSchema);
// --- DATABASE INDEXES FOR PERFORMANCE ---
orderSchema.index({ user: 1, createdAt: -1 }); // Speeds up customer order history
orderSchema.index({ restaurant: 1, status: 1 }); // Speeds up vendor active order dashboard


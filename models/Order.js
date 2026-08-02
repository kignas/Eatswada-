const mongoose = require('mongoose');
const crypto = require('crypto');

const orderItemSchema = new mongoose.Schema({
  menuItem:  { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' },
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

const orderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      unique: true,
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

    items: [orderItemSchema],

    // Address snapshot (do NOT ref — address can be deleted later)
    deliveryAddress: {
      tag:      String,
      house:    String,
      area:     String,
      landmark: String,
      city:     String,
      pincode:  String,
    },

    // Pricing (matches cart.html bill summary)
    subtotal:    { type: Number, required: true },
    deliveryFee: { type: Number, default: 40 },
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
        'placed',       // order placed, awaiting restaurant confirm
        'confirmed',    // restaurant accepted
        'preparing',    // kitchen is cooking
        'waiting_for_rider', // kitchen done, looking for a rider
        'assigned',     // rider accepted the delivery
        'out_for_delivery', // on the way
        'otp_verified', // customer's delivery OTP confirmed by rider
        'delivered',    // completed
        'cancelled',    // cancelled by user / restaurant
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

    // --- DELIVERY OTP (rider hands off to customer) ---
    // Hash/salt/expiry/attempts/lock are hidden by default (select: false) —
    // controllers explicitly opt in with .select('+deliveryOtpHash ...') when
    // they need to verify. deliveryOtpVerified stays selected because status
    // checks read it directly without an explicit .select().
    deliveryOtpHash: { type: String, select: false },
    deliveryOtpSalt: { type: String, select: false },
    deliveryOtpExpiresAt: { type: Date, select: false },
    deliveryOtpAttempts: { type: Number, default: 0, select: false },
    deliveryOtpLockedUntil: { type: Date, default: null, select: false },
    deliveryOtpVerified: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Rider integration compound index
orderSchema.index({ rider: 1, riderStatus: 1 });

/* ── Pre-save: generate order number ── */
orderSchema.pre('save', function (next) {
  if (this.isNew) {
    const ts   = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).substr(2, 4).toUpperCase();
    this.orderNumber = `NB-${ts}-${rand}`;

    // Push initial status event
    this.statusHistory.push({ status: 'placed', note: 'Order placed by customer' });

    // Estimated delivery: 40 mins from now
    this.estimatedDelivery = new Date(Date.now() + 40 * 60 * 1000);

    // Delivery OTP: 4-digit code the rider asks the customer for at
    // hand-off. Only the salted hash is persisted; the plaintext is kept
    // on the in-memory doc (not a schema path, so it's never written to
    // Mongo and never appears in toJSON output) for the controller to
    // read exactly once via order._plainDeliveryOtp before responding.
    const plainOtp = Math.floor(1000 + Math.random() * 9000).toString();
    const salt = crypto.randomBytes(16).toString('hex');
    this.deliveryOtpHash = crypto.scryptSync(plainOtp, salt, 32).toString('hex');
    this.deliveryOtpSalt = salt;
    this.deliveryOtpExpiresAt = new Date(this.estimatedDelivery.getTime() + 2 * 60 * 60 * 1000);
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

/* ── Instance method: strip delivery-OTP secrets before a doc goes out
   in an API response ── */
orderSchema.methods.clearOtpSecrets = function () {
  this.deliveryOtpHash = undefined;
  this.deliveryOtpSalt = undefined;
  this.deliveryOtpExpiresAt = undefined;
  this.deliveryOtpAttempts = undefined;
  this.deliveryOtpLockedUntil = undefined;
  this._plainDeliveryOtp = undefined;
  return this;
};

/* ── Instance method: check an entered delivery OTP against the stored
   hash. Mutates attempt/lock/verified state on `this` but does not
   save — the caller is responsible for order.save(). ── */
const OTP_MAX_ATTEMPTS = 5;
const OTP_LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

orderSchema.methods.verifyDeliveryOtp = async function (enteredOtp) {
  if (this.deliveryOtpLockedUntil && this.deliveryOtpLockedUntil > new Date()) {
    return { ok: false, reason: 'locked', lockedUntil: this.deliveryOtpLockedUntil };
  }

  if (!this.deliveryOtpHash || !this.deliveryOtpSalt) {
    return { ok: false, reason: 'not_set' };
  }

  if (this.deliveryOtpExpiresAt && this.deliveryOtpExpiresAt < new Date()) {
    return { ok: false, reason: 'expired' };
  }

  const enteredHash = crypto.scryptSync(String(enteredOtp), this.deliveryOtpSalt, 32).toString('hex');
  const storedBuf = Buffer.from(this.deliveryOtpHash, 'hex');
  const enteredBuf = Buffer.from(enteredHash, 'hex');
  const matches = storedBuf.length === enteredBuf.length && crypto.timingSafeEqual(storedBuf, enteredBuf);

  if (!matches) {
    this.deliveryOtpAttempts = (this.deliveryOtpAttempts || 0) + 1;

    if (this.deliveryOtpAttempts >= OTP_MAX_ATTEMPTS) {
      this.deliveryOtpLockedUntil = new Date(Date.now() + OTP_LOCK_DURATION_MS);
      return { ok: false, reason: 'locked_now', lockedUntil: this.deliveryOtpLockedUntil };
    }

    return { ok: false, reason: 'incorrect', attemptsRemaining: OTP_MAX_ATTEMPTS - this.deliveryOtpAttempts };
  }

  this.deliveryOtpVerified = true;
  this.deliveryOtpAttempts = 0;
  this.deliveryOtpLockedUntil = null;

  return { ok: true };
};

module.exports = mongoose.model('Order', orderSchema);

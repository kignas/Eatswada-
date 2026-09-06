const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      maxlength: [60, 'Name cannot exceed 60 characters'],
      default: 'Nearbite User',
    },
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      unique: true,
      trim: true,
      match: [/^\+?[1-9]\d{9,14}$/, 'Please enter a valid phone number'],
    },
    email: {
      type: String,
      unique: true,
      sparse: true,           // allows multiple null values
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email'],
    },
    password: {
      type: String,
      minlength: [6, 'Password must be at least 6 characters'],
      select: false,
    },
    avatar: {
      // Reused as the profile picture URL for every role, including riders.
      type: String,
      default: '',
    },
    role: {
      type: String,
      // 🚨 'vendor' and 'rider' included in allowed roles
      enum: ['user', 'vendor', 'admin', 'rider'],
      default: 'user',
    },
    // 🚨 THE SECURE LOCK: Connects the owner directly to their restaurant
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      default: null,
    },
    // Incremented whenever existing JWT sessions must be revoked.
    tokenVersion: {
      type: Number,
      default: 0,
      min: 0,
    },
    isActive: {
      // Reused as the rider Active / Inactive flag (same pattern as vendor).
      type: Boolean,
      default: true,
    },
    isPhoneVerified: {
      type: Boolean,
      default: false,
    },
    // Embedded addresses (fast lookup — no join needed for cart/checkout)
    addresses: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Address',
      },
    ],
    defaultAddress: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Address',
      default: null,
    },
    // Saved / favourited restaurants
    savedRestaurants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
      },
    ],
    // Veg preference (mirrors frontend veg-filter toggle)
    vegOnly: {
      type: Boolean,
      default: false,
    },
    otp: {
      code:      { type: String, select: false },
      expiresAt: { type: Date,   select: false },
      purpose:   { type: String, enum: ['login', 'signup', 'password_reset'], select: false, default: 'login' },
      // Per-account brute-force protection. The IP rate limiter alone is not
      // enough: an attacker on mobile data or a proxy pool rotates IPs freely,
      // and a short OTP with unlimited guesses is not a secret at all.
      attempts:    { type: Number, select: false, default: 0 },
      lockedUntil: { type: Date,   select: false },
      lastSentAt:  { type: Date,   select: false },
    },
    passwordResetTokenHash: { type: String, select: false },
    passwordResetExpiresAt: { type: Date, select: false },
    lastLogin: Date,

    // ── RIDER-SPECIFIC FIELDS ──────────────────────────────────
    // Nested under one path so non-rider documents (user/vendor/admin)
    // are completely unaffected — this whole object is simply absent
    // for them, exactly like restaurantId is unused for non-vendors.
    riderDetails: {
      vehicleType: {
        type: String,
        enum: ['bike', 'scooter', 'bicycle', 'car'],
      },
      vehicleNumber: {
        type: String,
        trim: true,
        uppercase: true,
      },
      deliveryZone: {
        type: String,
        trim: true,
      },
      isOnline: {
        type: Boolean,
        default: false,
      },
    },
  },
  { timestamps: true }
);

// Speeds up admin "find riders in zone X who are online" queries used when
// assigning an order to a rider.
userSchema.index({ role: 1, 'riderDetails.isOnline': 1, 'riderDetails.deliveryZone': 1 });

// No two riders should share a plate number. Sparse so it's simply ignored
// for every document that doesn't have riderDetails.vehicleNumber set.
userSchema.index({ 'riderDetails.vehicleNumber': 1 }, { unique: true, sparse: true });

/* ── Pre-save: hash password if modified ── */
userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});


/* ── Password helpers ── */
userSchema.methods.matchPassword = function (enteredPassword) {
  if (!this.password || !enteredPassword) return false;
  return bcrypt.compare(enteredPassword, this.password);
};

userSchema.methods.createPasswordResetToken = function () {
  const rawToken = crypto.randomBytes(32).toString('hex');
  this.passwordResetTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  this.passwordResetExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  return rawToken;
};

/* ── OTP constants ── */
const MAX_OTP_ATTEMPTS = 5;
const OTP_LOCKOUT_MS   = 15 * 60 * 1000;  // 15 min after 5 wrong codes
const OTP_RESEND_MS    = 60 * 1000;       // 60 s minimum between codes per account

/* ── Instance method: compare OTP (legacy boolean form) ── */
userSchema.methods.matchOTP = function (enteredOTP) {
  if (!this.otp || !this.otp.code) return false;
  if (this.otp.expiresAt < Date.now()) return false;
  // Constant-time compare so response timing can't leak a digit at a time.
  const a = Buffer.from(String(this.otp.code));
  const b = Buffer.from(String(enteredOTP));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

/**
 * checkOTP — the form every controller should use.
 *
 * Returns { ok, reason } and mutates the attempt/lock counters on `this`.
 * Does NOT save; the caller decides when to persist (and must persist even
 * on failure, or the attempt counter never increments).
 */
userSchema.methods.checkOTP = function (enteredOTP, expectedPurpose) {
  const now = new Date();

  if (this.otp?.lockedUntil && this.otp.lockedUntil > now) {
    return { ok: false, reason: 'locked' };
  }
  if (!this.otp?.code) {
    return { ok: false, reason: 'not_set' };
  }
  if (this.otp.expiresAt && this.otp.expiresAt < now) {
    return { ok: false, reason: 'expired' };
  }
  if (expectedPurpose && this.otp.purpose !== expectedPurpose) {
    return { ok: false, reason: 'wrong_purpose' };
  }

  if (this.matchOTP(enteredOTP)) {
    this.otp = undefined;   // single use — burn it on success
    return { ok: true };
  }

  this.otp.attempts = (this.otp.attempts || 0) + 1;

  if (this.otp.attempts >= MAX_OTP_ATTEMPTS) {
    // Invalidate the code itself, not just the session. Re-requesting is the
    // only way forward, and that path is throttled too.
    this.otp = { lockedUntil: new Date(Date.now() + OTP_LOCKOUT_MS) };
    return { ok: false, reason: 'locked_now' };
  }

  return { ok: false, reason: 'incorrect', attemptsRemaining: MAX_OTP_ATTEMPTS - this.otp.attempts };
};

/** True when this account asked for an OTP less than 60 s ago. */
userSchema.methods.otpRequestedTooRecently = function () {
  return !!(this.otp?.lastSentAt && Date.now() - this.otp.lastSentAt.getTime() < OTP_RESEND_MS);
};

/* ── Remove sensitive fields from JSON output ── */
userSchema.statics.OTP_LIMITS = { MAX_OTP_ATTEMPTS, OTP_LOCKOUT_MS, OTP_RESEND_MS };

userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.otp;
  delete obj.passwordResetTokenHash;
  delete obj.passwordResetExpiresAt;
  return obj;
};

module.exports = mongoose.model('User', userSchema);

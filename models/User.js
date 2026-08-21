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

/* ── Instance method: compare OTP ── */
userSchema.methods.matchOTP = function (enteredOTP) {
  if (!this.otp || !this.otp.code) return false;
  if (this.otp.expiresAt < Date.now()) return false;
  // Force both to be strings so 8499 exactly matches "8499"
  return String(this.otp.code) === String(enteredOTP);
};

/* ── Remove sensitive fields from JSON output ── */
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.otp;
  delete obj.passwordResetTokenHash;
  delete obj.passwordResetExpiresAt;
  return obj;
};

module.exports = mongoose.model('User', userSchema);

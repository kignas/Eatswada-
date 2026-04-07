const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

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
      type: String,
      default: '',
    },
    role: {
      type: String,
      enum: ['user', 'admin', 'restaurant_owner'],
      default: 'user',
    },
    isActive: {
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
    },
    lastLogin: Date,
  },
  { timestamps: true }
);

/* ── Pre-save: hash password if modified ── */
userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

/* ── Instance method: compare OTP ── */
userSchema.methods.matchOTP = function (enteredOTP) {
  if (!this.otp || !this.otp.code) return false;
  if (this.otp.expiresAt < Date.now()) return false;
  // Force both to be strings so 8499 exactly matches "8499"
  return String(this.otp.code) === String(enteredOTP);
};


/* ── Instance method: compare OTP ── */
userSchema.methods.matchOTP = function (enteredOTP) {
  if (!this.otp || !this.otp.code) return false;
  if (this.otp.expiresAt < Date.now()) return false;
  return this.otp.code === enteredOTP;
};

/* ── Remove sensitive fields from JSON output ── */
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.otp;
  return obj;
};

module.exports = mongoose.model('User', userSchema);

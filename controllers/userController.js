const crypto = require('crypto');
const User          = require('../models/User');
const Address       = require('../models/Address');
const generateToken = require('../utils/generateToken');
const { sendOTP, generateOTPCode } = require('../utils/sendOTP');
const asyncHandler  = require('express-async-handler');

const OTP_TTL_MS = 5 * 60 * 1000;
const normalizePhone = (phone) => String(phone || '').trim();
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

// Generic reply for every OTP failure. Never tell the caller whether the
// account exists, whether the code was wrong, or how many tries are left —
// each of those is a free hint for someone guessing.
const OTP_FAIL = 'Invalid or expired OTP.';
const OTP_LOCKED = 'Too many incorrect codes. Please request a new OTP in 15 minutes.';

const issueOTP = async (user, purpose) => {
  const otp = generateOTPCode();
  user.otp = {
    code: otp,
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
    purpose,
    attempts: 0,
    lockedUntil: null,
    lastSentAt: new Date(),
  };
  await user.save();
  await sendOTP(user.phone, otp);
};

// Every customer-facing auth handler looks the account up through this.
//
// SECURITY: the role filter is the whole point. Without it, /send-otp and
// /forgot-password match admin, vendor and rider accounts by phone number,
// which means the customer OTP flow doubles as a staff password reset for
// anyone who knows a staff phone number.
const findCustomerByPhone = (phone, extraSelect = '') =>
  User.findOne({ phone, role: 'user' })
    .select(`+otp.code +otp.expiresAt +otp.purpose +otp.attempts +otp.lockedUntil +otp.lastSentAt${extraSelect}`);

const sendOTPHandler = asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (/^\+?[6-9]\d{9,14}$/.test(phone) === false) {
    return res.status(400).json({ success: false, message: 'Enter a valid mobile number.' });
  }

  // A staff phone number must never be usable here. If one is supplied we
  // reply exactly as we would for a fresh customer number and send nothing —
  // no OTP is written to the staff account, and the caller learns nothing.
  const staffAccount = await User.findOne({ phone, role: { $ne: 'user' } }).select('_id');
  if (staffAccount) {
    return res.json({ success: true, message: 'OTP sent successfully' });
  }

  let user = await findCustomerByPhone(phone);
  if (!user) {
    user = new User({ phone, role: 'user', isPhoneVerified: false });
  }

  // Per-account throttle, on top of the per-IP limiter in the route. Stops one
  // number being used to burn SMS credit from many IPs.
  if (user.otpRequestedTooRecently()) {
    return res.status(429).json({
      success: false,
      message: 'Please wait a minute before requesting another OTP.',
    });
  }

  await issueOTP(user, 'login');
  res.json({ success: true, message: 'OTP sent successfully' });
});

const verifyOTPHandler = asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const otp = String(req.body.otp || '').trim();
  const user = await findCustomerByPhone(phone);
  if (!user) return res.status(400).json({ success: false, message: OTP_FAIL });

  const result = user.checkOTP(otp, 'login');
  if (!result.ok) {
    await user.save();   // persist the attempt counter / lock
    return res.status(400).json({
      success: false,
      message: result.reason === 'locked' || result.reason === 'locked_now' ? OTP_LOCKED : OTP_FAIL,
    });
  }

  user.isPhoneVerified = true;
  user.lastLogin = new Date();
  await user.save();
  res.json({
    success: true,
    message: 'Login successful',
    data: { user: user.toJSON(), token: generateToken(user._id, user.role) },
  });
});

const register = asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const phone = normalizePhone(req.body.phone);
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const otp = String(req.body.otp || '').trim();

  if (!/^\+?[6-9]\d{9,14}$/.test(phone)) return res.status(400).json({ success:false, message:'Enter a valid mobile number.' });
  if (password.length < 6) return res.status(400).json({ success:false, message:'Password must be at least 6 characters.' });
  if (!name || name.length < 2) return res.status(400).json({ success:false, message:'Name is required.' });
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ success:false, message:'Enter a valid email address.' });

  let user = await findCustomerByPhone(phone, ' +password');
  if (!user) return res.status(400).json({ success:false, message:'Please verify your mobile number first.' });
  if (user.isPhoneVerified && user.password) return res.status(409).json({ success:false, message:'This account already exists. Please log in.' });

  const otpResult = user.checkOTP(otp, 'login');
  if (!otpResult.ok) {
    await user.save();
    return res.status(400).json({
      success: false,
      message: otpResult.reason === 'locked' || otpResult.reason === 'locked_now' ? OTP_LOCKED : OTP_FAIL,
    });
  }
  const duplicateEmail = email ? await User.findOne({ email, _id: { $ne: user._id } }) : null;
  if (duplicateEmail) return res.status(409).json({ success:false, message:'This email is already registered.' });

  user.name = name;
  if (email) user.email = email;
  user.password = password;
  user.isPhoneVerified = true;
  user.lastLogin = new Date();
  await user.save();

  res.status(201).json({ success:true, data:{ user:user.toJSON(), token:generateToken(user._id, user.role) } });
});

const login = asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const password = String(req.body.password || '');
  // role: 'user' — staff sign in through their own portals, never here.
  const user = await User.findOne({ phone, role: 'user' }).select('+password');
  if (!user || !user.password || !(await user.matchPassword(password))) {
    return res.status(401).json({ success: false, message: 'Invalid phone or password.' });
  }
  if (!user.isActive) return res.status(403).json({ success:false, message:'Your account has been disabled.' });
  if (!user.isPhoneVerified) return res.status(403).json({ success:false, message:'Please verify your mobile number with OTP first.' });
  user.lastLogin = new Date();
  await user.save();
  res.json({ success:true, data:{ user:user.toJSON(), token:generateToken(user._id, user.role) } });
});

const requestPasswordReset = asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const generic = 'If an account exists for this number, we sent a verification code.';
  if (!/^\+?[6-9]\d{9,14}$/.test(phone)) return res.json({ success:true, message:generic });
  const user = await findCustomerByPhone(phone);
  if (!user || !user.isActive || !user.password) return res.json({ success:true, message:generic });
  if (user.otpRequestedTooRecently()) return res.json({ success:true, message:generic });
  await issueOTP(user, 'password_reset');
  res.json({ success:true, message:generic });
});

const verifyPasswordResetOTP = asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const otp = String(req.body.otp || '').trim();
  const user = await findCustomerByPhone(phone);
  if (!user || !user.isActive) {
    return res.status(400).json({ success:false, message:OTP_FAIL });
  }

  const result = user.checkOTP(otp, 'password_reset');
  if (!result.ok) {
    await user.save();
    return res.status(400).json({
      success: false,
      message: result.reason === 'locked' || result.reason === 'locked_now' ? OTP_LOCKED : OTP_FAIL,
    });
  }

  const resetToken = user.createPasswordResetToken();
  await user.save();
  res.json({ success:true, data:{ resetToken } });
});

const resetPassword = asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const resetToken = String(req.body.resetToken || '');
  const password = String(req.body.password || '');
  if (password.length < 6) return res.status(400).json({ success:false, message:'Password must be at least 6 characters.' });
  if (!resetToken) return res.status(400).json({ success:false, message:'Password reset session expired. Please request a new OTP.' });
  const hash = crypto.createHash('sha256').update(resetToken).digest('hex');
  const user = await User.findOne({ phone, role: 'user' }).select('+passwordResetTokenHash +passwordResetExpiresAt');
  if (!user || !user.passwordResetTokenHash || user.passwordResetTokenHash !== hash || !user.passwordResetExpiresAt || user.passwordResetExpiresAt < new Date()) {
    return res.status(400).json({ success:false, message:'Password reset session expired. Please request a new OTP.' });
  }
  user.password = password;
  user.passwordResetTokenHash = undefined;
  user.passwordResetExpiresAt = undefined;
  await user.save();
  res.json({ success:true, message:'Password changed successfully. You can now log in.' });
});

const getProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).populate('addresses').populate('defaultAddress');
  res.json({ success: true, data: user });
});

const updateProfile = asyncHandler(async (req, res) => {
  const { name, email, password, vegOnly, avatar } = req.body;
  const user = await User.findById(req.user._id);
  if (name !== undefined)    user.name    = name;
  if (email !== undefined)   user.email   = email;
  if (vegOnly !== undefined) user.vegOnly = vegOnly;
  if (avatar !== undefined)  user.avatar  = avatar;
  if (password !== undefined) {
    if (typeof password !== 'string' || password.length < 6) return res.status(400).json({ success:false, message:'Password must be at least 6 characters.' });
    user.password = password;
  }
  await user.save();
  res.json({ success: true, data: user.toJSON() });
});

const getAddresses = asyncHandler(async (req, res) => {
  const addresses = await Address.find({ user: req.user._id }).sort({ isDefault: -1 });
  res.json({ success: true, count: addresses.length, data: addresses });
});

const addAddress = asyncHandler(async (req, res) => {
  const { tag, house, area, landmark, city, pincode, isDefault, latitude, longitude, coordinates } = req.body;

  let geoCoordinates = null;
  if (Array.isArray(coordinates) && coordinates.length === 2) {
    geoCoordinates = [Number(coordinates[0]), Number(coordinates[1])];
  } else if (Number.isFinite(Number(longitude)) && Number.isFinite(Number(latitude))) {
    geoCoordinates = [Number(longitude), Number(latitude)];
  }
  if (!geoCoordinates || !Number.isFinite(geoCoordinates[0]) || !Number.isFinite(geoCoordinates[1]) ||
      geoCoordinates[0] < -180 || geoCoordinates[0] > 180 || geoCoordinates[1] < -90 || geoCoordinates[1] > 90) {
    return res.status(400).json({ success: false, message: 'A valid Google Maps/GPS location is required.' });
  }
  if (isDefault) await Address.updateMany({ user: req.user._id }, { isDefault: false });
  const address = await Address.create({
    user: req.user._id, tag, house, area, landmark, city, pincode,
    location: { type: 'Point', coordinates: geoCoordinates },
    isDefault: !!isDefault,
  });
  await User.findByIdAndUpdate(req.user._id, {
    $push: { addresses: address._id },
    ...(isDefault && { defaultAddress: address._id }),
  });
  res.status(201).json({ success: true, data: address });
});

const updateAddress = asyncHandler(async (req, res) => {
  const address = await Address.findOne({ _id: req.params.id, user: req.user._id });
  if (!address) return res.status(404).json({ success: false, message: 'Address not found' });
  const fields = ['tag','house','area','landmark','city','pincode'];
  fields.forEach(f => { if (req.body[f] !== undefined) address[f] = req.body[f]; });

  if (req.body.coordinates !== undefined || req.body.latitude !== undefined || req.body.longitude !== undefined) {
    let coords = Array.isArray(req.body.coordinates)
      ? [Number(req.body.coordinates[0]), Number(req.body.coordinates[1])]
      : [Number(req.body.longitude), Number(req.body.latitude)];

    if (!Number.isFinite(coords[0]) || !Number.isFinite(coords[1]) ||
        coords[0] < -180 || coords[0] > 180 || coords[1] < -90 || coords[1] > 90) {
      return res.status(400).json({ success: false, message: 'A valid Google Maps/GPS location is required.' });
    }
    address.location = { type: 'Point', coordinates: coords };
  }
  if (req.body.isDefault) {
    await Address.updateMany({ user: req.user._id }, { isDefault: false });
    address.isDefault = true;
    await User.findByIdAndUpdate(req.user._id, { defaultAddress: address._id });
  }
  await address.save();
  res.json({ success: true, data: address });
});

const deleteAddress = asyncHandler(async (req, res) => {
  const address = await Address.findOne({ _id: req.params.id, user: req.user._id });
  if (!address) return res.status(404).json({ success: false, message: 'Address not found' });
  await address.deleteOne();
  await User.findByIdAndUpdate(req.user._id, {
    $pull: { addresses: address._id },
    ...(String(req.user.defaultAddress) === req.params.id && { defaultAddress: null }),
  });
  res.json({ success: true, message: 'Address deleted' });
});

const setDefaultAddress = asyncHandler(async (req, res) => {
  const address = await Address.findOne({ _id: req.params.id, user: req.user._id });
  if (!address) return res.status(404).json({ success: false, message: 'Address not found' });
  await Address.updateMany({ user: req.user._id }, { isDefault: false });
  address.isDefault = true;
  await address.save();
  await User.findByIdAndUpdate(req.user._id, { defaultAddress: address._id });
  res.json({ success: true, data: address });
});


module.exports = {
  sendOTPHandler, verifyOTPHandler, register, login,
  requestPasswordReset, verifyPasswordResetOTP, resetPassword,
  getProfile, updateProfile,
  getAddresses, addAddress, updateAddress, deleteAddress, setDefaultAddress,
};

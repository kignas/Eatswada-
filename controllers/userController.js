const crypto = require('crypto');
const User          = require('../models/User');
const Address       = require('../models/Address');
const generateToken = require('../utils/generateToken');
const { sendOTP, generateOTPCode } = require('../utils/sendOTP');
const asyncHandler  = require('express-async-handler');

const OTP_TTL_MS = 5 * 60 * 1000;
const normalizePhone = (phone) => String(phone || '').trim();
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const isValidEmail = (email) => /^\S+@\S+\.\S+$/.test(email);

const issueOTP = async (user, purpose) => {
  if (user.otp?.lockedUntil && user.otp.lockedUntil > new Date()) {
    const error = new Error('Too many incorrect attempts. Please wait before requesting a new OTP.');
    error.statusCode = 429;
    throw error;
  }
  if (user.otpRequestedTooRecently()) {
    const retryAfter = Math.max(1, Math.ceil((60_000 - (Date.now() - user.otp.lastSentAt.getTime())) / 1000));
    const error = new Error(`Please wait ${retryAfter} seconds before requesting another OTP.`);
    error.statusCode = 429;
    throw error;
  }

  const otp = generateOTPCode();
  user.otp = {
    code: otp,
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
    purpose,
    attempts: 0,
    lastSentAt: new Date(),
  };
  await user.save();
  await sendOTP(user.phone, otp);
};

const sendOTPHandler = asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!/^\+?[6-9]\d{9,14}$/.test(phone)) {
    return res.status(400).json({ success: false, message: 'Enter a valid mobile number.' });
  }

  let user = await User.findOne({ phone }).select('+otp.code +otp.expiresAt +otp.purpose +otp.attempts +otp.lockedUntil +otp.lastSentAt');
  if (!user) {
    user = new User({ phone, isPhoneVerified: false });
  }

  await issueOTP(user, 'login');
  res.json({ success: true, message: 'OTP sent successfully' });
});

const verifyOTPHandler = asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const otp = String(req.body.otp || '').trim();
  console.log(`[OTP-VERIFY] handler phone=${phone.replace(/(\+91|\+?91)?(\d{2})\d{6}(\d{2})$/, '$1$2******$3')} otpLength=${otp.length}`);
  const user = await User.findOne({ phone }).select('+otp.code +otp.expiresAt +otp.purpose +otp.attempts +otp.lockedUntil +otp.lastSentAt');
  if (!user) {
    console.log('[OTP-VERIFY] user not found');
    return res.status(400).json({ success: false, message: 'Invalid or expired OTP.' });
  }
  const result = user.checkOTP(otp, 'login');
  if (!result.ok) {
    await user.save();
    return res.status(result.reason === 'locked' || result.reason === 'locked_now' ? 429 : 400).json({
      success: false,
      message: result.reason === 'locked' || result.reason === 'locked_now'
        ? 'Too many incorrect attempts. Please request a new OTP later.'
        : 'Invalid or expired OTP.'
    });
  }
  user.isPhoneVerified = true;
  user.lastLogin = new Date();
  await user.save();
  res.json({
    success: true,
    message: 'Login successful',
    data: { user: user.toJSON(), token: generateToken(user._id, user.role, user.tokenVersion) },
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

  let user = await User.findOne({ phone }).select('+otp.code +otp.expiresAt +otp.purpose +password');
  if (!user) return res.status(400).json({ success:false, message:'Please verify your mobile number first.' });
  if (user.isPhoneVerified && user.password) return res.status(409).json({ success:false, message:'This account already exists. Please log in.' });
  const otpResult = user.checkOTP(otp, 'login');
  if (!otpResult.ok) {
    await user.save();
    return res.status(otpResult.reason === 'locked' || otpResult.reason === 'locked_now' ? 429 : 400).json({ success:false, message:'Invalid or expired OTP.' });
  }
  const duplicateEmail = email ? await User.findOne({ email, _id: { $ne: user._id } }) : null;
  if (duplicateEmail) return res.status(409).json({ success:false, message:'This email is already registered.' });

  user.name = name;
  if (email) user.email = email;
  user.password = password;
  user.isPhoneVerified = true;
  user.otp = undefined;
  user.lastLogin = new Date();
  await user.save();

  res.status(201).json({ success:true, data:{ user:user.toJSON(), token:generateToken(user._id, user.role, user.tokenVersion) } });
});

const login = asyncHandler(async (req, res) => {
  const identifier = String(req.body.identifier ?? req.body.email ?? req.body.phone ?? '').trim();
  const password = String(req.body.password || '');
  if (!identifier || !password) {
    return res.status(400).json({ success: false, message: 'Email or mobile number and password are required.' });
  }

  const normalized = identifier.toLowerCase();
  const query = normalized.includes('@')
    ? { email: normalizeEmail(identifier) }
    : { phone: normalizePhone(identifier) };

  const user = await User.findOne(query).select('+password +googleUid');
  if (!user || !user.password || !(await user.matchPassword(password))) {
    return res.status(401).json({ success: false, message: 'Invalid email/mobile number or password.' });
  }
  if (!user.isActive) return res.status(403).json({ success:false, message:'Your account has been disabled.' });

  // Phone is a delivery/contact field in the new customer system. It is no
  // longer an authentication factor, so SMS/OTP verification is not required.
  user.lastLogin = new Date();
  await user.save();
  res.json({ success:true, data:{ user:user.toJSON(), token:generateToken(user._id, user.role, user.tokenVersion) } });
});

const requestEmailPasswordReset = asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const generic = 'If an account exists for this email, a verification code has been sent.';

  console.log(
    `[PASSWORD-RESET-OTP] Request received method=${req.method} ` +
    `path=${req.originalUrl} email=${email ? 'provided' : 'missing'}`
  );

  if (!isValidEmail(email)) {
    return res.json({ success: true, message: generic });
  }

  const user = await User.findOne({ email }).select(
    '+password +passwordResetOtpHash +passwordResetOtpExpiresAt ' +
    '+passwordResetOtpAttempts +passwordResetOtpLockedUntil +passwordResetOtpLastSentAt'
  );

  if (!user || !user.isActive || !user.password) {
    return res.json({ success: true, message: generic });
  }

  if (
    user.passwordResetOtpLockedUntil &&
    user.passwordResetOtpLockedUntil > new Date()
  ) {
    return res.status(429).json({
      success: false,
      message: 'Too many incorrect attempts. Please wait before requesting another OTP.',
    });
  }

  if (user.passwordResetOtpRequestedTooRecently()) {
    const retryAfter = Math.max(
      1,
      Math.ceil(
        (60_000 - (Date.now() - user.passwordResetOtpLastSentAt.getTime())) / 1000
      )
    );
    return res.status(429).json({
      success: false,
      message: `Please wait ${retryAfter} seconds before requesting another OTP.`,
    });
  }

  const otp = user.createPasswordResetOtp();
  await user.save();

  try {
    const { sendPasswordResetOTP } = require('../utils/sendPasswordResetEmail');
    console.log('[PASSWORD-RESET-OTP] Calling Brevo email service...');
    await sendPasswordResetOTP({ to: user.email, otp });
    console.log('[PASSWORD-RESET-OTP] Brevo email service completed successfully.');
  } catch (err) {
    // Do not leave a usable OTP behind when email delivery fails.
    user.passwordResetOtpHash = undefined;
    user.passwordResetOtpExpiresAt = undefined;
    user.passwordResetOtpAttempts = 0;
    user.passwordResetOtpLastSentAt = undefined;
    await user.save();

    // Keep provider/internal details server-side only. Never expose Brevo,
    // API, IP-address, request, or stack details to the customer.
    console.error(`[PASSWORD-RESET-OTP] Email delivery failed: ${err?.message || err}`);
    return res.status(503).json({
      success: false,
      message: 'Unable to send the verification code right now. Please try again later.',
    });
  }

  return res.json({ success: true, message: generic });
});

const verifyEmailPasswordResetOTP = asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const otp = String(req.body.otp || '').replace(/\D/g, '').slice(0, 6);

  if (!isValidEmail(email) || !/^\d{6}$/.test(otp)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid or expired OTP.',
    });
  }

  const user = await User.findOne({ email }).select(
    '+passwordResetOtpHash +passwordResetOtpExpiresAt ' +
    '+passwordResetOtpAttempts +passwordResetOtpLockedUntil +passwordResetOtpLastSentAt'
  );

  if (!user || !user.isActive) {
    return res.status(400).json({
      success: false,
      message: 'Invalid or expired OTP.',
    });
  }

  const result = user.checkPasswordResetOtp(otp);

  if (!result.ok) {
    await user.save();

    return res.status(
      result.reason === 'locked' || result.reason === 'locked_now' ? 429 : 400
    ).json({
      success: false,
      message:
        result.reason === 'locked' || result.reason === 'locked_now'
          ? 'Too many incorrect attempts. Please request a new OTP later.'
          : 'Invalid or expired OTP.',
    });
  }

  // After OTP verification, issue a short-lived reset session token.
  // It is used only in the next API call; no URL containing this token is emailed.
  const resetToken = user.createPasswordResetToken();
  await user.save();

  return res.json({
    success: true,
    message: 'OTP verified successfully.',
    data: { resetToken },
  });
});

const resetPasswordByEmailOTP = asyncHandler(async (req, res) => {
  const resetToken = String(req.body.resetToken || '').trim();
  const password = String(req.body.password || '');

  if (!resetToken) {
    return res.status(400).json({
      success: false,
      message: 'Password reset session is invalid or expired.',
    });
  }

  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({
      success: false,
      message: 'Password must be 8-128 characters.',
    });
  }

  const hash = crypto.createHash('sha256').update(resetToken).digest('hex');

  const user = await User.findOne({
    passwordResetTokenHash: hash,
    passwordResetExpiresAt: { $gt: new Date() },
  }).select('+password +passwordResetTokenHash +passwordResetExpiresAt');

  if (!user || !user.isActive) {
    return res.status(400).json({
      success: false,
      message: 'Password reset session is invalid or expired.',
    });
  }

  user.password = password;
  user.tokenVersion = (Number(user.tokenVersion) || 0) + 1;
  user.passwordResetTokenHash = undefined;
  user.passwordResetExpiresAt = undefined;
  await user.save();

  return res.json({
    success: true,
    message: 'Password changed successfully. You can now log in.',
  });
});

const logout = asyncHandler(async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
  res.json({ success: true, message: 'Logged out successfully.' });
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
    user.tokenVersion = (Number(user.tokenVersion) || 0) + 1;
  }
  await user.save();

  // If the password changes, tokenVersion is intentionally incremented above
  // to revoke the old JWT. The current onboarding session must receive a fresh
  // JWT, otherwise the very next protected request is correctly rejected with
  // 401 and the frontend may send the user back to login.
  const responseData = { user: user.toJSON() };
  if (password !== undefined) {
    responseData.token = generateToken(user._id, user.role, user.tokenVersion);
  }

  res.json({ success: true, data: responseData });
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
  requestEmailPasswordReset, verifyEmailPasswordResetOTP, resetPasswordByEmailOTP,
  logout, getProfile, updateProfile,
  getAddresses, addAddress, updateAddress, deleteAddress, setDefaultAddress,
};

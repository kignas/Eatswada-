const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const generateToken = require('../utils/generateToken');
const { verifyFirebaseIdToken } = require('../utils/firebaseAdmin');

const normalizeEmail = v => typeof v === 'string' ? v.trim().toLowerCase() : '';
const normalizePhone = v => typeof v === 'string' ? v.trim() : '';

exports.firebaseAuth = asyncHandler(async (req, res) => {
  const { idToken, phone } = req.body || {};
  const decoded = await verifyFirebaseIdToken(idToken);
  const email = normalizeEmail(decoded.email);
  const firebasePhone = normalizePhone(decoded.phone_number);
  const suppliedPhone = normalizePhone(phone);

  let user = email ? await User.findOne({ email }) : null;
  if (!user && firebasePhone) user = await User.findOne({ phone: firebasePhone });

  // Google Sign-In does not necessarily contain a phone number. Ask only for
  // the phone needed by Eatswada's customer account schema; Google remains the
  // authentication factor.
  if (!user && !firebasePhone && !suppliedPhone) {
    return res.json({ success: false, code: 'PHONE_REQUIRED', message: 'Add your phone number to finish creating your Eatswada account.' });
  }

  const finalPhone = firebasePhone || suppliedPhone;

  if (!user) {
    const phoneExists = await User.findOne({ phone: finalPhone });
    if (phoneExists) {
      return res.status(409).json({ success: false, code: 'PHONE_ALREADY_REGISTERED', message: 'This phone number already belongs to an Eatswada account. Please use that account to sign in.' });
    }
    user = await User.create({
      name: String(decoded.name || 'Eatswada User').trim().slice(0, 60),
      phone: finalPhone,
      email: email || undefined,
      avatar: String(decoded.picture || ''),
      role: 'user',
      isPhoneVerified: Boolean(firebasePhone),
    });
  } else {
    if (!user.isActive) return res.status(403).json({ success: false, message: 'Your account has been disabled.' });
    if (suppliedPhone && !firebasePhone && suppliedPhone !== user.phone) {
      return res.status(409).json({ success: false, code: 'PHONE_MISMATCH', message: 'The phone number does not match this Eatswada account.' });
    }
    let changed = false;
    if (!user.email && email) { user.email = email; changed = true; }
    if (!user.avatar && decoded.picture) { user.avatar = String(decoded.picture); changed = true; }
    if (firebasePhone && !user.isPhoneVerified) { user.isPhoneVerified = true; changed = true; }
    if (changed) await user.save();
  }

  user.lastLogin = new Date();
  await user.save();
  const token = generateToken(user._id, user.role, user.tokenVersion);
  return res.json({ success: true, authProvider: 'firebase', data: { user: user.toJSON(), token } });
});

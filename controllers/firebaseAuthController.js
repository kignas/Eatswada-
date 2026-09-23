const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const generateToken = require('../utils/generateToken');
const { verifyFirebaseIdToken } = require('../models/firebaseAdmin');

const normalizeEmail = v => typeof v === 'string' ? v.trim().toLowerCase() : '';
const normalizePhone = v => typeof v === 'string' ? v.trim() : '';
const isValidPhone = phone => /^\+?[6-9]\d{9,14}$/.test(phone);
const isValidEmail = email => /^\S+@\S+\.\S+$/.test(email);
const isGoogleToken = decoded => decoded?.firebase?.sign_in_provider === 'google.com';

function safeName(value) {
  return String(value || 'Eatswada User').trim().slice(0, 60) || 'Eatswada User';
}

async function findGoogleUser(decoded) {
  const email = normalizeEmail(decoded.email);
  const googleUid = String(decoded.uid || '').trim();

  let user = googleUid
    ? await User.findOne({ googleUid }).select('+googleUid +password')
    : null;
  if (!user && email) {
    user = await User.findOne({ email }).select('+googleUid +password');
  }
  return { user, email, googleUid };
}

/**
 * Google sign-in entry point.
 *
 * A brand-new Google account is NOT created here because phone + password are
 * required during Eatswada profile completion. We return PROFILE_REQUIRED and
 * let the client call /firebase/complete-profile with the same verified Google
 * ID token.
 */
exports.firebaseAuth = asyncHandler(async (req, res) => {
  const { idToken } = req.body || {};
  const decoded = await verifyFirebaseIdToken(idToken);

  if (!isGoogleToken(decoded)) {
    return res.status(400).json({
      success: false,
      code: 'GOOGLE_SIGN_IN_REQUIRED',
      message: 'Please continue with Google to use this login method.',
    });
  }

  let { user, email, googleUid } = await findGoogleUser(decoded);

  if (!email || decoded.email_verified !== true) {
    return res.status(400).json({
      success: false,
      code: 'VERIFIED_EMAIL_REQUIRED',
      message: 'A verified Google email address is required.',
    });
  }

  if (!user) {
    /*
     * Progressive Google onboarding: create the authenticated customer shell
     * immediately. Phone/password/profile details are optional for browsing
     * and can be completed later from Home/Profile. This removes the old
     * login -> complete-profile -> location -> address waterfall while keeping
     * the account tied to the verified Google identity.
     *
     * The account is intentionally created without a password/phone. The
     * profile completion endpoint (or /users/profile) adds those fields later.
     */
    user = await User.create({
      name: safeName(decoded.name),
      email,
      googleUid,
      avatar: String(decoded.picture || ''),
      role: 'user',
      isPhoneVerified: false,
      lastLogin: new Date(),
    });

    return res.json({
      success: true,
      authProvider: 'google',
      profileComplete: false,
      data: {
        user: user.toJSON(),
        token: generateToken(user._id, user.role, user.tokenVersion),
      },
    });
  }

  if (!user.isActive) {
    return res.status(403).json({ success: false, message: 'Your account has been disabled.' });
  }

  let changed = false;
  if (googleUid && !user.googleUid) {
    user.googleUid = googleUid;
    changed = true;
  }
  if (decoded.picture && user.avatar !== String(decoded.picture)) {
    // Google is the source for accounts created through Google. This keeps the
    // customer's profile photo current when they change it at Google.
    user.avatar = String(decoded.picture);
    changed = true;
  }
  if (user.email !== email) {
    user.email = email;
    changed = true;
  }
  if (changed) await user.save();

  user.lastLogin = new Date();
  await user.save();

  return res.json({
    success: true,
    authProvider: 'google',
    data: {
      user: user.toJSON(),
      token: generateToken(user._id, user.role, user.tokenVersion),
    },
  });
});

/**
 * Completes a brand-new Google customer's Eatswada account.
 * The Firebase ID token is verified server-side; no client-supplied Google UID
 * is trusted. Phone is collected for delivery/contact, not SMS verification.
 */
exports.completeGoogleProfile = asyncHandler(async (req, res) => {
  const { idToken } = req.body || {};
  const decoded = await verifyFirebaseIdToken(idToken);

  if (!isGoogleToken(decoded) || decoded.email_verified !== true) {
    return res.status(401).json({ success: false, message: 'Valid Google authentication is required.' });
  }

  const email = normalizeEmail(decoded.email);
  const googleUid = String(decoded.uid || '').trim();
  const phone = normalizePhone(req.body.phone);
  const name = safeName(req.body.name || decoded.name);
  const password = String(req.body.password || '');

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ success: false, message: 'A valid Google email address is required.' });
  }
  if (!isValidPhone(phone)) {
    return res.status(400).json({ success: false, message: 'Enter a valid mobile number.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
  }
  if (name.length < 2) {
    return res.status(400).json({ success: false, message: 'Name is required.' });
  }

  // Never silently overwrite an existing account. A Google email that already
  // exists should have been handled by /firebase, while a phone collision must
  // be resolved through the existing account's login flow.
  const [emailUser, googleUser, phoneUser] = await Promise.all([
    User.findOne({ email }).select('+googleUid +password'),
    googleUid ? User.findOne({ googleUid }).select('+googleUid +password') : null,
    User.findOne({ phone }).select('+googleUid +password'),
  ]);

  if (emailUser || googleUser) {
    const existing = emailUser || googleUser;
    if (existing.googleUid === googleUid || existing.googleUid == null) {
      return res.status(409).json({
        success: false,
        code: 'ACCOUNT_EXISTS',
        message: 'An Eatswada account already exists for this Google account. Please log in instead.',
      });
    }
    return res.status(409).json({ success: false, message: 'This email is already registered.' });
  }

  if (phoneUser) {
    return res.status(409).json({
      success: false,
      code: 'PHONE_ALREADY_REGISTERED',
      message: 'This mobile number already belongs to an Eatswada account. Please use that account to log in.',
    });
  }

  const user = await User.create({
    name,
    email,
    phone,
    password,
    googleUid,
    avatar: String(decoded.picture || ''),
    role: 'user',
    // The phone is NOT SMS verified. It is only the customer's contact number.
    isPhoneVerified: false,
  });

  user.lastLogin = new Date();
  await user.save();

  return res.status(201).json({
    success: true,
    authProvider: 'google',
    data: {
      user: user.toJSON(),
      token: generateToken(user._id, user.role, user.tokenVersion),
    },
  });
});

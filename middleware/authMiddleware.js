const jwt  = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer ')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ success: false, message: 'Not authorised — no token' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select('-password -otp');

    if (!req.user || !req.user.isActive) {
      return res.status(401).json({ success: false, message: 'Account not found or deactivated' });
    }

    next();
  } catch (err) {
    // 🚨 THIS IS THE FIX: Print the EXACT raw system error instead of a generic message 🚨
    return res.status(401).json({ success: false, message: 'SYSTEM AUTH ERROR: ' + err.message });
  }
};

// Keep your authorize and optionalAuth functions below this exactly as they are!
// ...


/**
 * authorize — restrict to certain roles
 * Usage: router.delete('/x', protect, authorize('admin'), handler)
 */
const authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: `Role '${req.user.role}' is not authorised for this action`,
    });
  }
  next();
};

/**
 * optionalAuth — attaches user if token present, else continues as guest
 */
const optionalAuth = async (req, res, next) => {
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer ')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = await User.findById(decoded.id).select('-password -otp');
    } catch (_) { /* ignore */ }
  }
  next();
};

module.exports = { protect, authorize, optionalAuth };
                               

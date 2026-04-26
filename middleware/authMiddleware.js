const jwt  = require('jsonwebtoken');
const User = require('../models/User');

/**
 * protect — require a valid JWT
 */
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
    
    // 🚨 THE FIX: Removed '-otp' to prevent the MongoDB Path Collision 🚨
    req.user = await User.findById(decoded.id).select('-password');

    if (!req.user || !req.user.isActive) {
      return res.status(401).json({ success: false, message: 'Account not found or deactivated' });
    }

    next();
  } catch (err) {
    // Keeping the truth serum just in case!
    return res.status(401).json({ success: false, message: 'SYSTEM AUTH ERROR: ' + err.message });
  }
};

/**
 * authorize — restrict to certain roles
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
      
      // 🚨 THE FIX: Removed '-otp' here too 🚨
      req.user = await User.findById(decoded.id).select('-password');
    } catch (_) { /* ignore */ }
  }
  next();
};

module.exports = { protect, authorize, optionalAuth };

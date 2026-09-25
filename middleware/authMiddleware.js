'use strict';

const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Keep the auth query small: authorization does not need the user's full
// document, addresses, saved restaurants, FCM tokens, or OTP/reset fields.
const AUTH_PROJECTION = '_id role isActive tokenVersion restaurantId permissions name phone';

const protect = async (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.slice(7).trim();
  }

  if (!token) {
    return res.status(401).json({ success: false, message: 'Not authorised — no token provided.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select(AUTH_PROJECTION).lean();

    if (!req.user || !req.user.isActive) {
      return res.status(401).json({ success: false, message: 'Account not found or deactivated.' });
    }

    if ((Number(decoded.tv) || 0) !== (Number(req.user.tokenVersion) || 0)) {
      return res.status(401).json({ success: false, message: 'Session expired or revoked. Please log in again.' });
    }

    next();
  } catch (err) {
    if (process.env.NODE_ENV === 'development') {
      console.error('[authMiddleware.protect] JWT verification failed:', err.message);
    }
    return res.status(401).json({ success: false, message: 'Session expired or invalid. Please log in again.' });
  }
};

const authorize = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: `Access denied. Role '${req.user?.role ?? 'unknown'}' is not permitted for this action.`,
    });
  }
  next();
};

const optionalAuth = async (req, res, next) => {
  const header = req.headers.authorization;
  const token = header && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return next();

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select(AUTH_PROJECTION).lean();
    if (user && user.isActive && (Number(decoded.tv) || 0) === (Number(user.tokenVersion) || 0)) {
      req.user = user;
    }
  } catch (_) {
    // Optional auth intentionally continues as a guest.
  }
  next();
};

module.exports = { protect, authorize, optionalAuth };

'use strict';

const jwt  = require('jsonwebtoken');
const User = require('../models/User');

/**
 * protect — requires a valid, non-expired JWT in the Authorization header.
 *
 * Attaches the full User document (minus password) to req.user.
 * Rejects deactivated accounts even if the token is technically valid.
 *
 * Error messages are intentionally generic to the client.
 * The real error is logged server-side for debugging on Render.
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
    console.log('[protect] No token in request to', req.method, req.originalUrl);
    return res.status(401).json({
      success: false,
      message: 'Not authorised — no token provided.',
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    

    // Select all fields except password.
    // '-otp' was intentionally removed — it caused a MongoDB path-collision
    // error on accounts where the otp sub-document does not exist.
    req.user = await User.findById(decoded.id).select('-password');

    if (!req.user) {
      console.log('[protect] No user found for id:', decoded.id);
      return res.status(401).json({
        success: false,
        message: 'Account not found. Please log in again.',
      });
    }

    if (!req.user.isActive) {
      console.log('[protect] User found but isActive is false:', req.user._id);
      return res.status(401).json({
        success: false,
        message: 'Your account has been deactivated. Please contact support.',
      });
    }

    
    next();
  } catch (err) {
    // Log internally — do NOT expose err.message to the client in production.
    console.error('[authMiddleware.protect] JWT verification failed:', err.message);

    return res.status(401).json({
      success: false,
      message: 'Session expired or invalid. Please log in again.',
    });
  }
};

/**
 * authorize — restricts access to specific roles.
 *
 * Must be used AFTER protect so that req.user is guaranteed to exist.
 *
 * Usage:  router.delete('/item/:id', protect, authorize('admin', 'vendor'), handler)
 */
const authorize = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: `Access denied. Role '${req.user?.role ?? 'unknown'}' is not permitted for this action.`,
    });
  }
  next();
};

/**
 * optionalAuth — attaches user to req if a valid token is present.
 *
 * Continues as guest (req.user = undefined) if no token or token is invalid.
 * Never rejects the request. Used for public routes that show extra info to
 * logged-in users (e.g., personalised feeds, saved addresses).
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
      req.user = await User.findById(decoded.id).select('-password');
    } catch (_) {
      // Silently ignore — this is intentional for optional auth.
    }
  }

  next();
};

module.exports = { protect, authorize, optionalAuth };

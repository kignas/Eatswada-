/**
 * Centralised production-safe error handling middleware.
 * Must be the LAST middleware registered in server.js.
 */

const isProduction = () => process.env.NODE_ENV === 'production';

// 404 — no route matched. Do not echo the requested URL in production.
const notFound = (req, res, next) => {
  const error = new Error('Route not found');
  error.statusCode = 404;
  next(error);
};

// A payment-gateway (Razorpay) rejection. The SDK rejects with an object that
// carries an `error` payload ({ code, description, reason, ... }). We detect it
// so the real cause is always logged server-side, while the browser only ever
// sees a safe, non-sensitive message.
function isGatewayError(err) {
  return !!(err && err.error && typeof err.error === 'object' &&
    (err.error.description || err.error.code || err.error.reason));
}

// Global error handler — maps known errors to safe client messages.
// Unexpected/internal errors are intentionally generic in production, but they
// are ALWAYS logged in full so production issues remain diagnosable.
const errorHandler = (err, req, res, next) => {
  let statusCode = Number(err.statusCode || err.status) || 500;
  let message = 'Internal Server Error';
  let logDetail = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);

  // Mongoose: bad ObjectId. Do not expose the submitted value.
  if (err.name === 'CastError') {
    message = 'Resource not found';
    statusCode = 404;
  }

  // Mongoose: duplicate key.
  else if (err.code === 11000) {
    const field = Object.keys(err.keyValue || err.keyPattern || {})[0];
    const safeFields = {
      email: 'Email', phone: 'Phone number', orderNumber: 'Order number',
      slug: 'Slug', 'riderDetails.vehicleNumber': 'Vehicle number'
    };
    message = safeFields[field] ? `${safeFields[field]} already exists` : 'A record with these details already exists';
    statusCode = 409;
  }

  // Mongoose: validation error. Mongoose validation messages are application
  // validation text, not raw stack traces/database details.
  else if (err.name === 'ValidationError') {
    message = Object.values(err.errors || {}).map(e => e.message).filter(Boolean).join(', ') || 'Validation failed';
    statusCode = 422;
  }

  // Mongoose optimistic concurrency — another request updated this same
  // order after it was read. Treat this as a safe retry/conflict, not a 500.
  else if (err.name === 'VersionError') {
    message = 'This order was updated by another request. Please refresh and try again.';
    statusCode = 409;
  }

  // JWT errors — safe, non-sensitive messages.
  else if (err.name === 'JsonWebTokenError') { message = 'Invalid token'; statusCode = 401; }
  else if (err.name === 'TokenExpiredError') { message = 'Token expired'; statusCode = 401; }

  // Multer upload errors.
  else if (err.name === 'MulterError') {
    message = err.code === 'LIMIT_FILE_SIZE' ? 'Uploaded file is too large.' : 'File upload failed.';
    statusCode = 400;
  }

  // Payment gateway (Razorpay) failure. The raw gateway text can contain
  // account/config detail, so the browser gets a safe generic message — but
  // the full reason (e.g. "Authentication failed", "key invalid") is logged.
  // A gateway auth/config failure is a server-side problem, not bad customer
  // input, so surface it as 502 (Bad Gateway) unless the gateway itself
  // returned a rate-limit.
  else if (isGatewayError(err) || /razorpay/i.test(err.message || '')) {
    logDetail = `[gateway] code=${err.error?.code || ''} desc=${err.error?.description || err.message || ''} | ${err.stack || ''}`;
    message = 'Payment could not be processed right now. Please try again in a moment.';
    if (statusCode < 500 && statusCode !== 429) statusCode = 502;
  }

  // Trusted operational errors: a controller deliberately set a 4xx status and
  // a user-facing message ("Restaurant is currently closed", "Add ₹40 more to
  // reach the minimum order", "delivers only within 10 km"). These are safe to
  // show and must NOT be masked as a generic "Internal Server Error".
  else if (statusCode >= 400 && statusCode < 500 && err.message) {
    message = err.message;
  }

  // Service-unavailable operational messages (e.g. a dependency not configured)
  // are safe to show and point the user at the right action.
  else if (statusCode === 503 && err.message) {
    message = err.message;
  }

  // In development, expose the real message for unexpected server errors too.
  if (!isProduction() && statusCode >= 500 && err.message) message = err.message;

  // Always record server-side failures, gateway failures, and anything in
  // development. This is what makes a masked production 500 (like a bad
  // Razorpay key) traceable in the Render logs.
  const shouldLog = statusCode >= 500 || isGatewayError(err) || !isProduction();
  if (shouldLog) {
    const where = `${req && req.method ? req.method : ''} ${req && req.originalUrl ? req.originalUrl : ''}`.trim();
    console.error(`[ERROR] ${statusCode}${where ? ' ' + where : ''} — ${logDetail}`);
  }

  const response = { success: false, message };
  if (!isProduction()) response.stack = err.stack;

  res.status(statusCode).json(response);
};

module.exports = { notFound, errorHandler };

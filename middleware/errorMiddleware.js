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

// Global error handler — maps known errors to safe client messages.
// Unexpected/internal errors are intentionally generic in production.
const errorHandler = (err, req, res, next) => {
  let statusCode = Number(err.statusCode || err.status) || 500;
  let message = 'Internal Server Error';

  // Mongoose: bad ObjectId. Do not expose the submitted value.
  if (err.name === 'CastError') {
    message = 'Resource not found';
    statusCode = 404;
  }

  // Mongoose: duplicate key.
  if (err.code === 11000) {
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
  if (err.name === 'ValidationError') {
    message = Object.values(err.errors || {}).map(e => e.message).filter(Boolean).join(', ') || 'Validation failed';
    statusCode = 422;
  }

  // JWT errors — safe, non-sensitive messages.
  if (err.name === 'JsonWebTokenError') { message = 'Invalid token'; statusCode = 401; }
  if (err.name === 'TokenExpiredError') { message = 'Token expired'; statusCode = 401; }

  // Multer upload errors.
  if (err.name === 'MulterError') {
    message = err.code === 'LIMIT_FILE_SIZE' ? 'Uploaded file is too large.' : 'File upload failed.';
    statusCode = 400;
  }

  // In development, preserve useful diagnostics. In production, never expose
  // internal error messages or stack traces to the client.
  if (!isProduction() && statusCode === 500 && err.message) message = err.message;

  if (!isProduction()) {
    console.error(`[ERROR] ${statusCode} — ${err.stack || err.message || err}`);
  } else if (statusCode >= 500) {
    console.error(`[ERROR] ${statusCode} — ${err.name || 'Error'}`);
  }

  const response = { success: false, message };
  if (!isProduction()) response.stack = err.stack;

  res.status(statusCode).json(response);
};

module.exports = { notFound, errorHandler };

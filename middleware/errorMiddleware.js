/**
 * Centralised error handling middleware
 * Must be the LAST middleware registered in server.js
 */

// 404 — no route matched
const notFound = (req, res, next) => {
  const error = new Error(`Route not found — ${req.originalUrl}`);
  error.statusCode = 404;
  next(error);
};

// Global error handler
const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || err.status || 500;
  let message    = err.message || 'Internal Server Error';

  // Mongoose: bad ObjectId
  if (err.name === 'CastError') {
    message    = `Resource not found — invalid id: ${err.value}`;
    statusCode = 404;
  }

  // Mongoose: duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    message    = `${field} already exists`;
    statusCode = 409;
  }

  // Mongoose: validation error
  if (err.name === 'ValidationError') {
    message    = Object.values(err.errors).map(e => e.message).join(', ');
    statusCode = 422;
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError')  { message = 'Invalid token'; statusCode = 401; }
  if (err.name === 'TokenExpiredError')  { message = 'Token expired';  statusCode = 401; }

  const response = {
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  };

  if (process.env.NODE_ENV === 'development') {
    console.error(`[ERROR] ${statusCode} — ${message}`);
  }

  res.status(statusCode).json(response);
};

module.exports = { notFound, errorHandler };
  

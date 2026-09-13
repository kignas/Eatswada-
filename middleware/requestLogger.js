'use strict';

// ─────────────────────────────────────────────────────────────────────
// Foundation-1.1 — production request logging.
//
// Structured, single-line-per-request logging that runs in ALL
// environments (the existing morgan('dev') stays dev-only). No new
// dependency: it writes JSON to stdout, which Render captures.
//
// It NEVER logs bodies, passwords, tokens, card data, or OTP values —
// only method, path, status, duration, a request id, and a masked actor.
// Sensitive query strings are stripped; only the path is recorded.
// ─────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

// Tag high-value paths so they are easy to grep in production logs.
function classify(path) {
  if (path.startsWith('/api/payments') || path.includes('/webhook')) return 'PAYMENT';
  if (path.startsWith('/api/orders')) return 'ORDER';
  if (path.startsWith('/api/auth') || path.includes('/login') || path.includes('/otp')) return 'AUTH';
  if (path.startsWith('/api/settlements')) return 'SETTLEMENT';
  if (path.startsWith('/api/admin')) return 'ADMIN';
  return 'REQUEST';
}

function maskActor(req) {
  const id = req?.user?._id || req?.user?.id;
  if (!id) return 'anon';
  const s = String(id);
  return s.length <= 6 ? '***' : `${s.slice(0, 4)}…${s.slice(-2)}`;
}

function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  const requestId = crypto.randomUUID();
  // Expose the id so handlers/other middleware can correlate if they want.
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  // Path only — never the query string (may carry tokens/emails).
  const path = (req.originalUrl || req.url || '').split('?')[0];
  const tag = classify(path);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const line = {
      t: new Date().toISOString(),
      tag,
      id: requestId,
      method: req.method,
      path,
      status: res.statusCode,
      ms: Math.round(durationMs * 10) / 10,
      actor: maskActor(req),
      origin: req.headers?.origin || '',
    };
    // One JSON object per line — cheap to grep, cheap to ship to a log tool later.
    console.log(`[HTTP] ${JSON.stringify(line)}`);
  });

  next();
}

module.exports = { requestLogger };

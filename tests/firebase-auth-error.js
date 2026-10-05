'use strict';
// Regression: an invalid/expired Firebase ID token must surface as 401, never
// 500, and must not leak Firebase codes, tokens, or stack traces.
const assert = require('assert');

const { errorHandler } = require('../middleware/errorMiddleware');

function invoke(err, env = 'production') {
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = env;
  const response = {
    statusCode: null, body: null, headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const oldError = console.error;
  console.error = () => {};
  try {
    errorHandler(err, { method: 'POST', path: '/api/auth/firebase' }, response, () => {});
  } finally {
    console.error = oldError;
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
  }
  return response;
}

// ── 1. Error middleware maps a Firebase auth failure to 401, safely ────────
const mapped = invoke(Object.assign(
  new Error('Session expired or invalid. Please log in again.'),
  { statusCode: 401, isFirebaseAuthError: true },
));
assert.strictEqual(mapped.statusCode, 401);
assert.strictEqual(mapped.body.success, false);
assert.ok(!('stack' in mapped.body), 'stack must not be exposed in production');
assert.ok(!/firebase|stack/i.test(mapped.body.message), 'must not leak Firebase detail');
assert.ok(!/auth\//.test(mapped.body.message), 'must not leak Firebase error code');

// ── 2. A raw unmapped error still becomes a generic 500 (unchanged) ────────
const unmapped = invoke(new Error('boom'));
assert.strictEqual(unmapped.statusCode, 500);
assert.strictEqual(unmapped.body.message, 'Internal Server Error');

// ── 3. verifyFirebaseIdToken maps real Firebase auth codes to 401 ──────────
// Inject a fake firebase-admin so the real mapping branch is exercised without
// network access or credentials.
const adminPath = require.resolve('firebase-admin');
const originalAdminEntry = require.cache[adminPath];
const fakeApp = {
  auth: () => ({
    verifyIdToken: async () => {
      throw Object.assign(new Error('Firebase ID token has expired.'), { code: 'auth/id-token-expired' });
    },
  }),
};
const fakeAdmin = { initializeApp: () => fakeApp, credential: { cert: () => ({}) } };
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: fakeAdmin };

process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  project_id: 'test-project',
  client_email: 'test@test-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n',
});
delete require.cache[require.resolve('../models/firebaseAdmin')];
const { verifyFirebaseIdToken } = require('../models/firebaseAdmin');

(async () => {
  let expired;
  try { await verifyFirebaseIdToken('a'.repeat(120)); } catch (e) { expired = e; }
  assert.ok(expired, 'expired token must throw');
  assert.strictEqual(expired.statusCode, 401);
  assert.strictEqual(expired.isFirebaseAuthError, true);
  assert.strictEqual(expired.message, 'Session expired or invalid. Please log in again.');
  assert.ok(!/auth\//.test(expired.message), 'Firebase code must not reach the client message');

  // Pre-validation (unchanged): a too-short token is a 400, not a 500.
  let short;
  try { await verifyFirebaseIdToken('short'); } catch (e) { short = e; }
  assert.strictEqual(short.statusCode, 400);

  // Restore module cache so this test cannot affect anything else.
  if (originalAdminEntry) require.cache[adminPath] = originalAdminEntry; else delete require.cache[adminPath];
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  console.log('Firebase auth error mapping: 6 passed, 0 failed');
})().catch(err => { console.error(err); process.exit(1); });

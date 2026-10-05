const admin = require('firebase-admin');

let firebaseApp = null;

function getFirebaseAdmin() {
  if (firebaseApp) return firebaseApp;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    const err = new Error('Firebase authentication is not configured on the server');
    err.statusCode = 503;
    throw err;
  }
  let serviceAccount;
  try { serviceAccount = JSON.parse(raw); }
  catch { const err = new Error('FIREBASE_SERVICE_ACCOUNT_JSON is invalid'); err.statusCode = 500; throw err; }
  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
    const err = new Error('Firebase service account is incomplete'); err.statusCode = 500; throw err;
  }
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  firebaseApp = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return firebaseApp;
}

// firebase-admin rejects an expired, revoked, malformed or otherwise invalid
// ID token with a FirebaseAuthError whose `code` is namespaced `auth/*`. That
// is an authentication failure, not a server fault, so it must map to 401.
// Server-side/transient codes (internal-error, network-request-failed,
// certificate-fetch-error, project-not-found) are intentionally NOT listed —
// those stay as server errors so a Google outage is not reported to the
// customer as "please log in again".
const FIREBASE_AUTH_FAILURE_CODES = new Set([
  'auth/id-token-expired',
  'auth/id-token-revoked',
  'auth/argument-error',
  'auth/invalid-id-token',
  'auth/invalid-argument',
  'auth/invalid-user-token',
  'auth/user-token-expired',
  'auth/user-disabled',
  'auth/user-not-found',
]);

async function verifyFirebaseIdToken(idToken) {
  if (typeof idToken !== 'string' || idToken.length < 100 || idToken.length > 8192) {
    const err = new Error('Valid Firebase ID token is required'); err.statusCode = 400; throw err;
  }
  try {
    return await getFirebaseAdmin().auth().verifyIdToken(idToken, true);
  } catch (err) {
    const code = err && typeof err.code === 'string' ? err.code : '';
    if (FIREBASE_AUTH_FAILURE_CODES.has(code)) {
      // Log the Firebase code only — never the token or Firebase's raw message.
      console.warn(`[firebaseAuth] ID token rejected: ${code}`);
      const authErr = new Error('Session expired or invalid. Please log in again.');
      authErr.statusCode = 401;
      authErr.isFirebaseAuthError = true;
      throw authErr;
    }
    throw err;
  }
}

/**
 * Send a DATA-ONLY push to a set of FCM device tokens, reusing the same
 * initialized admin app used for phone-auth verification. Data-only (no
 * `notification` block) means the receiving service worker renders the
 * alert itself — this avoids duplicate notifications on web and gives the
 * vendor page full control over sound/vibration.
 *
 * Returns the list of tokens FCM reported as permanently invalid, so the
 * caller can prune them from the user document.
 */
async function sendPushToTokens(tokens, data) {
  if (!Array.isArray(tokens) || tokens.length === 0) return [];
  const stringData = {};
  Object.entries(data || {}).forEach(([k, v]) => { stringData[k] = String(v == null ? '' : v); });

  const messaging = getFirebaseAdmin().messaging();
  const resp = await messaging.sendEachForMulticast({
    tokens,
    data: stringData,
    android: { priority: 'high' },
    webpush: { headers: { Urgency: 'high', TTL: '120' } },
  });

  const invalid = [];
  resp.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/invalid-argument') {
        invalid.push(tokens[i]);
      }
    }
  });
  return invalid;
}

module.exports = { verifyFirebaseIdToken, sendPushToTokens };

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

async function verifyFirebaseIdToken(idToken) {
  if (typeof idToken !== 'string' || idToken.length < 100 || idToken.length > 8192) {
    const err = new Error('Valid Firebase ID token is required'); err.statusCode = 400; throw err;
  }
  return getFirebaseAdmin().auth().verifyIdToken(idToken, true);
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

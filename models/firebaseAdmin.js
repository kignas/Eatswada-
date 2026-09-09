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

module.exports = { verifyFirebaseIdToken };

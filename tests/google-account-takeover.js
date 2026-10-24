// Regression test: pre-hijacking of a customer account through an UNVERIFIED email.
// Attack (before): an attacker signs up with their own Google account, then sets their profile
// email to the victim's address (updateProfile never verified it, and the attacker still holds the
// password). When the victim later "Continues with Google", /users/firebase matched the account BY
// EMAIL ONLY, ignored that it belonged to a different Google identity, and logged the victim into the
// attacker's account (attacker keeps the password and sees the victim's addresses/orders). The same
// match-by-email also handed out vendor/admin tokens to a Google user whose email matched a staff account.
// Now:
//   1. a Google identity only ever signs in to an account bound to the SAME Google uid;
//   2. an account found by email that is bound to a DIFFERENT Google uid, or that is a staff account,
//      is refused (409 ACCOUNT_EXISTS, no token, nothing changed);
//   3. an old never-Google-linked account that matches the verified email is claimed safely: its
//      password is removed and its old sessions revoked, so whoever prepared it loses access;
//   4. a Google-linked account's email can no longer be edited (it is the verified Google identity).
// Runs with no database (in-memory fakes). Usage: npm run test:google-account-takeover
const Module = require('module');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const FIREBASE = path.join(ROOT, 'controllers/firebaseAuthController.js');
const USERCTL = path.join(ROOT, 'controllers/userController.js');

// ── in-memory User model ─────────────────────────────────────────────────────────
const db = [];
let seq = 0;
function makeDoc(data) {
  const doc = {
    _id: 'U' + (++seq), role: 'user', isActive: true, tokenVersion: 0, googleUid: undefined, password: undefined, avatar: '', saves: 0, ...data,
    async save() { this.saves++; return this; },
    toJSON() { const { save, toJSON, password, googleUid, ...rest } = this; return rest; },
  };
  db.push(doc);
  return doc;
}
function User(data) { return makeDoc(data); }
User.findOne = (filter) => {
  const q = {
    select() { return q; },
    then(res, rej) {
      const hit = db.find(d => (filter.googleUid !== undefined ? d.googleUid === filter.googleUid : true)
        && (filter.email !== undefined ? d.email === filter.email : true)
        && (filter.phone !== undefined ? d.phone === filter.phone : true)) || null;
      return Promise.resolve(filter._id && filter._id.$ne ? null : hit).then(res, rej);
    },
  };
  return q;
};
User.create = async (data) => makeDoc(data);
User.findById = (id) => { const q = { select() { return q; }, populate() { return q; }, then(res, rej) { return Promise.resolve(db.find(d => d._id === id) || null).then(res, rej); } }; return q; };

const tokens = [];
const idTokens = {}; // fake ID token string -> decoded Firebase claims
const stubs = {
  [path.join(ROOT, 'models/User.js')]: User,
  [path.join(ROOT, 'models/Address.js')]: {},
  [path.join(ROOT, 'models/firebaseAdmin.js')]: { verifyFirebaseIdToken: async (t) => { if (!idTokens[t]) throw Object.assign(new Error('bad token'), { statusCode: 401 }); return idTokens[t]; } },
  [path.join(ROOT, 'utils/generateToken.js')]: (id, role, tv) => { tokens.push({ id, role, tv }); return `jwt-${id}-v${tv}`; },
  [path.join(ROOT, 'utils/sendOTP.js')]: { sendOTP: async () => {}, generateOTPCode: () => '1234' },
  'express-async-handler': (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
};
const anything = new Proxy(function () {}, { get: (t, p) => (p === 'then' ? undefined : anything), apply: () => anything, construct: () => anything });
const origLoad = Module._load;
const load = (file) => {
  Module._load = function (request, parent, ...rest) {
    if (parent && parent.filename === file && request !== 'crypto') {
      const resolved = request.startsWith('.') ? path.resolve(path.dirname(file), request) + '.js' : request;
      return stubs[resolved] || stubs[request] || anything;
    }
    return origLoad.call(this, request, parent, ...rest);
  };
  try { return require(file); } finally { Module._load = origLoad; }
};
const { firebaseAuth, completeGoogleProfile } = load(FIREBASE);
const { updateProfile } = load(USERCTL);
const realLog = console.log; console.log = () => {}; console.warn = () => {};

// ── helpers ──────────────────────────────────────────────────────────────────────
const call = async (handler, req) => {
  const out = {};
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; if (!out.status) out.status = 200; return res; } };
  let err = null;
  await handler(req, res, (e) => { err = e; });
  if (err) throw err;
  return out;
};
const google = (uid, email, over = {}) => { const t = 'tok-' + uid + '-' + email + '-'.padEnd(110, 'x'); idTokens[t] = { uid, email, email_verified: true, name: 'G User', picture: 'p.png', firebase: { sign_in_provider: 'google.com' }, ...over }; return t; };
const signIn = (uid, email, over) => call(firebaseAuth, { body: { idToken: google(uid, email, over) } });
const reset = () => { db.length = 0; tokens.length = 0; seq = 0; };
const VICTIM = 'victim@gmail.com';

(async () => {
  let pass = 0;
  const t = async (name, fn) => { reset(); await fn(); pass++; realLog('PASS', name); };

  await t('A: the attack — victim signs in with Google but the email is held by an account bound to ANOTHER Google uid → refused, no token, account untouched', async () => {
    const attacker = makeDoc({ email: VICTIM, googleUid: 'G_ATTACKER', password: 'attacker-hash', tokenVersion: 2 });
    const r = await signIn('G_VICTIM', VICTIM);
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, 'ACCOUNT_EXISTS');
    assert.strictEqual(tokens.length, 0, 'no JWT may be issued');
    assert.strictEqual(attacker.googleUid, 'G_ATTACKER');
    assert.strictEqual(attacker.password, 'attacker-hash');
    assert.strictEqual(attacker.saves, 0);
  });

  await t('B: a staff account (vendor / admin / rider) matching the Google email is never signed in through Google', async () => {
    for (const role of ['vendor', 'admin', 'rider']) {
      reset(); const staff = makeDoc({ email: VICTIM, role, password: 'staff-hash' });
      const r = await signIn('G_ANY', VICTIM);
      assert.strictEqual(r.status, 409, role);
      assert.strictEqual(tokens.length, 0, role);
      assert.strictEqual(staff.googleUid, undefined, `${role}: must not be linked`);
      assert.strictEqual(staff.password, 'staff-hash', `${role}: password untouched`);
      assert.strictEqual(staff.saves, 0, role);
    }
  });

  await t('C: an old account that was never Google-linked is claimed safely: linked, password removed, old sessions revoked', async () => {
    const legacy = makeDoc({ email: VICTIM, password: 'prepared-by-someone-else', tokenVersion: 3 });
    const r = await signIn('G_VICTIM', VICTIM);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(legacy.googleUid, 'G_VICTIM');
    assert.strictEqual(legacy.password, undefined, 'the previous password must be gone');
    assert.strictEqual(legacy.tokenVersion, 4, 'old JWTs must be revoked');
    assert.deepStrictEqual(tokens, [{ id: legacy._id, role: 'user', tv: 4 }], 'the new token carries the new version');
    assert.ok(!('password' in r.body.data.user) && !('googleUid' in r.body.data.user), 'secrets are not returned');
  });

  await t('D: after being claimed, the next Google sign-in is a normal login (no further revocation)', async () => {
    const legacy = makeDoc({ email: VICTIM, password: 'x', tokenVersion: 3 });
    await signIn('G_VICTIM', VICTIM);
    tokens.length = 0;
    const r = await signIn('G_VICTIM', VICTIM);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(legacy.tokenVersion, 4);
    assert.deepStrictEqual(tokens, [{ id: legacy._id, role: 'user', tv: 4 }]);
  });

  await t('E: normal returning Google user (matched by uid) → logged in, password and sessions untouched (regression)', async () => {
    const u = makeDoc({ email: VICTIM, googleUid: 'G_VICTIM', password: 'my-hash', tokenVersion: 5 });
    const r = await signIn('G_VICTIM', VICTIM);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(u.password, 'my-hash');
    assert.strictEqual(u.tokenVersion, 5);
    assert.deepStrictEqual(tokens, [{ id: u._id, role: 'user', tv: 5 }]);
  });

  await t('F: a returning user who changed their Google email is still found by uid and the email follows (regression)', async () => {
    const u = makeDoc({ email: 'old@gmail.com', googleUid: 'G_VICTIM', password: 'h' });
    const r = await signIn('G_VICTIM', 'new@gmail.com');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(u.email, 'new@gmail.com');
    assert.strictEqual(u.password, 'h');
  });

  await t('G: brand-new Google user → PROFILE_REQUIRED, nothing is created (regression)', async () => {
    const r = await signIn('G_NEW', 'new@gmail.com');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.code, 'PROFILE_REQUIRED');
    assert.strictEqual(db.length, 0);
    assert.strictEqual(tokens.length, 0);
  });

  await t('H: a disabled account is refused (403) and is NOT claimed or linked', async () => {
    const linked = makeDoc({ email: VICTIM, googleUid: 'G_VICTIM', isActive: false });
    assert.strictEqual((await signIn('G_VICTIM', VICTIM)).status, 403);
    reset();
    const legacy = makeDoc({ email: VICTIM, isActive: false, password: 'p', tokenVersion: 1 });
    assert.strictEqual((await signIn('G_VICTIM', VICTIM)).status, 403);
    assert.strictEqual(legacy.googleUid, undefined);
    assert.strictEqual(legacy.password, 'p');
    assert.strictEqual(legacy.tokenVersion, 1);
    assert.strictEqual(tokens.length, 0);
  });

  await t('I: an unverified Google email never signs in or claims anything (regression)', async () => {
    const legacy = makeDoc({ email: VICTIM, password: 'p', tokenVersion: 1 });
    const r = await signIn('G_X', VICTIM, { email_verified: false });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(legacy.googleUid, undefined);
    assert.strictEqual(legacy.tokenVersion, 1);
    assert.strictEqual(tokens.length, 0);
  });

  await t('J: complete-profile cannot take over an existing account: other Google uid, staff, or never-linked → 409, untouched', async () => {
    const body = (uid) => ({ idToken: google(uid, VICTIM), phone: '9876543210', password: 'new-password-1', name: 'Mallory', adultConfirmed: true });
    const cases = [
      { label: 'other google uid', data: { email: VICTIM, googleUid: 'G_ATTACKER', password: 'a' } },
      { label: 'staff', data: { email: VICTIM, role: 'vendor', password: 'a' } },
      { label: 'staff that was once Google-linked to this same uid', data: { email: VICTIM, role: 'vendor', googleUid: 'G_VICTIM', password: 'a' } },
      { label: 'never linked', data: { email: VICTIM, password: 'a' } },
    ];
    for (const c of cases) {
      reset(); const u = makeDoc(c.data);
      const r = await call(completeGoogleProfile, { body: body('G_VICTIM') });
      assert.strictEqual(r.status, 409, c.label);
      assert.strictEqual(tokens.length, 0, c.label);
      assert.strictEqual(u.password, 'a', c.label);
      assert.strictEqual(u.saves, 0, c.label);
    }
  });

  await t('K: complete-profile for a brand-new Google user still creates the account and returns a token (regression)', async () => {
    const r = await call(completeGoogleProfile, { body: { idToken: google('G_NEW', 'new@gmail.com'), phone: '9876543210', password: 'new-password-1', name: 'Asha', adultConfirmed: true } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(db.length, 1);
    assert.strictEqual(db[0].googleUid, 'G_NEW');
    assert.strictEqual(tokens.length, 1);
  });

  await t('L: updateProfile — a Google-linked account cannot change its email (400, unchanged); resubmitting the same email is fine', async () => {
    const u = makeDoc({ email: 'me@gmail.com', googleUid: 'G_ME', password: 'h', name: 'Me' });
    const r = await call(updateProfile, { user: { _id: u._id }, body: { email: VICTIM } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, 'EMAIL_LINKED_TO_GOOGLE');
    assert.strictEqual(u.email, 'me@gmail.com');
    assert.strictEqual(u.saves, 0);
    const clear = await call(updateProfile, { user: { _id: u._id }, body: { email: '' } });
    assert.strictEqual(clear.status, 400, 'cannot blank it either');
    const same = await call(updateProfile, { user: { _id: u._id }, body: { email: ' ME@gmail.com ', name: 'New Name' } });
    assert.strictEqual(same.status, 200);
    assert.strictEqual(u.email, 'me@gmail.com');
    assert.strictEqual(u.name, 'New Name', 'other profile edits still work');
  });

  await t('M: updateProfile — an account that is not Google-linked can still change its email (regression)', async () => {
    const u = makeDoc({ email: 'old@x.com', password: 'h', name: 'Me' });
    const r = await call(updateProfile, { user: { _id: u._id }, body: { email: 'new@x.com' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(u.email, 'new@x.com');
  });

  await t('N: static guard — googleUid is select:false, so every query that relies on it must request it', async () => {
    const fs = require('fs');
    const user = fs.readFileSync(USERCTL, 'utf8');
    const fb = fs.readFileSync(FIREBASE, 'utf8');
    const up = user.match(/const updateProfile[\s\S]*?\.select\(([^)]*)\)/);
    assert.ok(up && /\+googleUid/.test(up[1]), 'updateProfile must select +googleUid: ' + (up && up[1]));
    const finder = fb.match(/async function findGoogleUser[\s\S]*?return \{/)[0];
    assert.strictEqual((finder.match(/\.select\('\+googleUid \+password'\)/g) || []).length, 2, 'both lookups must select +googleUid');
  });

  realLog(`\n${pass} scenarios passed`);
})().catch((e) => { console.log = realLog; console.error('FAIL:', e.message); process.exit(1); });

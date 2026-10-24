// Regression test: the CUSTOMER phone-OTP endpoints must only ever work for customer accounts.
// Before: POST /users/send-otp + /users/verify-otp (and /users/register) looked an account up by
// phone alone, so anyone who could pass a 4-digit SMS OTP for an ADMIN / vendor / rider phone got a
// JWT for that account, skipping the password login (and the admin login's own 5-per-15-min limiter).
// Now: staff accounts get no OTP, cannot verify one, and cannot be "registered" over; responses are
// identical to the normal ones, so the endpoints do not reveal which phones belong to staff.
// Runs with no database (in-memory fakes). Usage: npm run test:customer-otp-role-gate
const Module = require('module');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const CONTROLLER = path.join(ROOT, 'controllers/userController.js');

// ── in-memory User model ─────────────────────────────────────────────────────────
const users = new Map(); // phone -> doc
let created = 0;
function makeDoc(data) {
  const doc = {
    _id: 'U' + (++created), role: 'user', isActive: true, isPhoneVerified: false, tokenVersion: 0, otp: undefined, password: undefined, saves: 0,
    ...data,
    async save() { this.saves++; users.set(this.phone, this); return this; },
    otpRequestedTooRecently() { return false; },
    // minimal stand-in for the real checkOTP: right code, not expired, right purpose
    checkOTP(entered, purpose) {
      if (!this.otp || !this.otp.code) return { ok: false, reason: 'no_otp' };
      if (this.otp.expiresAt && this.otp.expiresAt < new Date()) return { ok: false, reason: 'expired' };
      if (purpose && this.otp.purpose !== purpose) return { ok: false, reason: 'wrong_purpose' };
      if (String(entered) !== String(this.otp.code)) return { ok: false, reason: 'incorrect' };
      this.otp = undefined;
      return { ok: true };
    },
    toJSON() { const { save, checkOTP, otpRequestedTooRecently, toJSON, ...rest } = this; return rest; },
  };
  return doc;
}
function User(data) { return makeDoc(data); }
User.findOne = (filter) => {
  const q = { select() { return q; }, then(res, rej) { return Promise.resolve(filter.phone ? users.get(filter.phone) || null : null).then(res, rej); } };
  return q;
};
const sent = [];
const tokens = [];
const stubs = {
  [path.join(ROOT, 'models/User.js')]: User,
  [path.join(ROOT, 'models/Address.js')]: {},
  [path.join(ROOT, 'utils/generateToken.js')]: (id, role) => { tokens.push({ id, role }); return 'jwt-' + id; },
  [path.join(ROOT, 'utils/sendOTP.js')]: { sendOTP: async (phone, otp) => { sent.push({ phone, otp }); }, generateOTPCode: () => '4321' },
  'express-async-handler': (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
};
const anything = new Proxy(function () {}, { get: (t, p) => (p === 'then' ? undefined : anything), apply: () => anything, construct: () => anything });
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (parent && parent.filename === CONTROLLER && request !== 'crypto') {
    const resolved = request.startsWith('.') ? path.resolve(path.dirname(CONTROLLER), request) + '.js' : request;
    return stubs[resolved] || stubs[request] || anything;
  }
  return origLoad.call(this, request, parent, ...rest);
};
const { sendOTPHandler, verifyOTPHandler, register } = require(CONTROLLER);
Module._load = origLoad;
const realLog = console.log; console.log = () => {}; console.warn = () => {}; console.warn = () => {};

// ── helpers ──────────────────────────────────────────────────────────────────────
const call = async (handler, body) => {
  const out = {};
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; if (!out.status) out.status = 200; return res; } };
  let err = null;
  await handler({ body }, res, (e) => { err = e; });
  if (err) throw err;
  return out;
};
const PHONE = { admin: '9000000001', vendor: '9000000002', rider: '9000000003', user: '9000000004' };
const future = () => new Date(Date.now() + 5 * 60 * 1000);
const seed = (role, over = {}) => { const d = makeDoc({ phone: PHONE[role], role, name: role, ...over }); users.set(d.phone, d); return d; };
const withOtp = (role, over = {}) => seed(role, { otp: { code: '4321', expiresAt: future(), purpose: 'login', attempts: 0, lastSentAt: new Date(Date.now() - 120000) }, ...over });
const reset = () => { users.clear(); sent.length = 0; tokens.length = 0; created = 0; };
const STAFF = ['admin', 'vendor', 'rider'];

(async () => {
  let pass = 0;
  const t = async (name, fn) => { reset(); await fn(); pass++; realLog('PASS', name); };

  await t('A: send-otp for an admin / vendor / rider phone → no SMS, no OTP stored, account untouched', async () => {
    for (const role of STAFF) {
      reset(); const d = seed(role);
      const r = await call(sendOTPHandler, { phone: PHONE[role] });
      assert.strictEqual(r.status, 200, role);
      assert.strictEqual(sent.length, 0, `${role}: an SMS OTP must not be sent`);
      assert.strictEqual(d.otp, undefined, `${role}: no OTP may be stored`);
      assert.strictEqual(d.saves, 0, `${role}: account must not be modified`);
    }
  });

  await t('B: the reply for a staff phone is identical to the reply for a customer phone (no staff-phone oracle)', async () => {
    seed('user'); seed('admin');
    const customer = await call(sendOTPHandler, { phone: PHONE.user });
    const staff = await call(sendOTPHandler, { phone: PHONE.admin });
    assert.deepStrictEqual(staff, customer);
  });

  await t('C: send-otp still works for an existing customer and for a brand-new phone (regression)', async () => {
    const d = seed('user');
    assert.strictEqual((await call(sendOTPHandler, { phone: PHONE.user })).status, 200);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(d.otp.code, '4321');
    const r = await call(sendOTPHandler, { phone: '9111111111' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(sent.length, 2);
    assert.ok(users.get('9111111111'), 'new customer record is created as before');
    assert.strictEqual(users.get('9111111111').role, 'user');
  });

  await t('D: verify-otp with a VALID stored OTP on a staff account → refused, no token, account untouched', async () => {
    for (const role of STAFF) {
      reset(); const d = withOtp(role);
      const r = await call(verifyOTPHandler, { phone: PHONE[role], otp: '4321' });
      assert.strictEqual(r.status, 400, role);
      assert.strictEqual(r.body.success, false);
      assert.strictEqual(tokens.length, 0, `${role}: no JWT may be issued`);
      assert.ok(!d.lastLogin, `${role}: lastLogin must not be set`);
      assert.strictEqual(d.isPhoneVerified, false, `${role}: must not be marked verified`);
    }
  });

  await t('E: the staff refusal is the same reply as an unknown phone (same status and message)', async () => {
    withOtp('admin');
    const staff = await call(verifyOTPHandler, { phone: PHONE.admin, otp: '4321' });
    const unknown = await call(verifyOTPHandler, { phone: '9222222222', otp: '4321' });
    assert.deepStrictEqual(staff, unknown);
  });

  await t('F: verify-otp for a customer still logs in and returns a token (regression)', async () => {
    withOtp('user');
    const r = await call(verifyOTPHandler, { phone: PHONE.user, otp: '4321' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.token, 'jwt-U1');
    assert.deepStrictEqual(tokens, [{ id: 'U1', role: 'user' }]);
    assert.strictEqual(users.get(PHONE.user).isPhoneVerified, true);
  });

  await t('G: register over a staff phone with a valid OTP → refused, password not set, no token', async () => {
    for (const role of STAFF) {
      reset(); const d = withOtp(role, { isPhoneVerified: false });
      const r = await call(register, { name: 'Attacker', phone: PHONE[role], password: 'hunter2hunter2', otp: '4321' });
      assert.ok([400, 409].includes(r.status), `${role}: got ${r.status}`);
      assert.strictEqual(tokens.length, 0, `${role}: no JWT may be issued`);
      assert.strictEqual(d.password, undefined, `${role}: password must not be set`);
      assert.strictEqual(d.name, role, `${role}: name must not change`);
      assert.strictEqual(d.role, role);
    }
  });

  await t('H: register for a normal new customer still works (regression)', async () => {
    withOtp('user');
    const r = await call(register, { name: 'Asha', phone: PHONE.user, password: 'secret-pass-1', otp: '4321' });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.data.token, 'jwt-U1');
    assert.strictEqual(users.get(PHONE.user).role, 'user');
  });

  await t('I: an account that has no role field set is treated as a customer (legacy documents keep working)', async () => {
    const d = withOtp('user'); delete d.role;
    const r = await call(verifyOTPHandler, { phone: PHONE.user, otp: '4321' });
    assert.strictEqual(r.status, 200);
  });

  realLog(`\n${pass} scenarios passed`);
})().catch((e) => { console.log = realLog; console.error('FAIL:', e.message); process.exit(1); });

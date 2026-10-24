// Regression test: changing a password through PUT /api/users/profile needs the CURRENT password.
// Before: any request carrying a valid token could set a NEW password with no proof of the old one,
// so a stolen / left-open session became a permanent account takeover (the attacker locks the
// owner out). Now: if the account already has a password, `currentPassword` must be sent and
// correct; an account with NO password yet (first-time onboarding) can still set one. Guesses are
// limited per account. Forgotten passwords still go through the email-OTP reset flow.
// Runs with no database (in-memory fakes). Usage: npm run test:profile-password-change
const Module = require('module');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const CONTROLLER = path.join(ROOT, 'controllers/userController.js');
const ROUTES = path.join(ROOT, 'routes/userRoutes.js');

function loadWith(file, stubs) {
  const anything = new Proxy(function () {}, { get: (t, p) => (p === 'then' ? undefined : anything), apply: () => anything, construct: () => anything });
  const origLoad = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (parent && parent.filename === file && request !== 'crypto') {
      const resolved = request.startsWith('.') ? path.resolve(path.dirname(file), request) + '.js' : request;
      return stubs[resolved] || stubs[request] || anything;
    }
    return origLoad.call(this, request, parent, ...rest);
  };
  try { return require(file); } finally { Module._load = origLoad; }
}

// ── in-memory User model ─────────────────────────────────────────────────────────
const OLD = 'old-password-1';
let doc;
const makeDoc = (over = {}) => ({
  _id: 'U1', role: 'user', name: 'Asha', email: 'a@x.com', password: 'hashed-old', tokenVersion: 3, saves: 0, matchChecks: 0,
  async matchPassword(pw) { this.matchChecks++; if (typeof pw !== 'string') throw new Error('bcrypt: data and hash must be strings'); return pw === OLD; },
  async save() { this.saves++; if (this.password !== 'hashed-old' && !this._hashed) { this._hashed = true; } return this; },
  toJSON() { const { matchPassword, save, toJSON, password, ...rest } = this; return rest; },
  ...over,
});
const User = { findById: () => ({ select: () => Promise.resolve(doc) }), findOne: () => ({ select: () => Promise.resolve(null) }) };
const tokens = [];
const controller = loadWith(CONTROLLER, {
  [path.join(ROOT, 'models/User.js')]: User,
  [path.join(ROOT, 'models/Address.js')]: {},
  [path.join(ROOT, 'utils/generateToken.js')]: (id, role, tv) => { tokens.push({ id, role, tv }); return `jwt-${id}-${tv}`; },
  'express-async-handler': (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
});

// ── capture the routes + limiter options ─────────────────────────────────────────
const limiters = [];
const routes = [];
const router = {};
for (const m of ['get', 'post', 'put', 'patch', 'delete', 'use']) router[m] = (p, ...h) => { routes.push({ method: m, path: p, handlers: h }); return router; };
const rateLimitStub = (opts) => { const fn = (req, res, next) => next(); fn.opts = opts; limiters.push(fn); return fn; };
loadWith(ROUTES, { express: { Router: () => router }, 'express-rate-limit': rateLimitStub });

const realLog = console.log; console.log = () => {}; console.warn = () => {};
const call = async (body) => {
  const out = {};
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; if (!out.status) out.status = 200; return res; } };
  let err = null;
  await controller.updateProfile({ user: { _id: 'U1' }, body }, res, (e) => { err = e; });
  if (err) throw err;
  return out;
};
const reset = (over) => { doc = makeDoc(over); tokens.length = 0; };

(async () => {
  let pass = 0;
  const t = async (name, fn) => {
    try { await fn(); } catch (e) { console.log = realLog; console.error('FAIL', name, '-', e.message); process.exit(1); }
    pass++; realLog('PASS', name);
  };
  const untouched = () => { assert.strictEqual(doc.password, 'hashed-old', 'password was changed'); assert.strictEqual(doc.tokenVersion, 3, 'sessions were revoked / version bumped'); assert.strictEqual(doc.saves, 0, 'account was saved'); assert.strictEqual(tokens.length, 0, 'a token was issued'); };

  await t('A: account WITH a password, new password and no currentPassword → 400 CURRENT_PASSWORD_REQUIRED, nothing changed', async () => {
    reset();
    const r = await call({ password: 'brand-new-pass' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.success, false);
    assert.strictEqual(r.body.code, 'CURRENT_PASSWORD_REQUIRED');
    untouched();
  });

  await t('B: wrong currentPassword → 403 CURRENT_PASSWORD_INCORRECT, nothing changed', async () => {
    reset();
    const r = await call({ password: 'brand-new-pass', currentPassword: 'guess-1234' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'CURRENT_PASSWORD_INCORRECT');
    untouched();
  });

  await t('C: correct currentPassword → 200, password set, other sessions revoked, fresh token returned', async () => {
    reset();
    const r = await call({ password: 'brand-new-pass', currentPassword: OLD });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(doc.password, 'brand-new-pass');
    assert.strictEqual(doc.tokenVersion, 4);
    assert.strictEqual(r.body.data.token, 'jwt-U1-4');
    assert.ok(!('password' in r.body.data.user) && !('currentPassword' in r.body.data.user), 'secret leaked in response');
  });

  await t('D: account with NO password yet (first-time onboarding) can set one without currentPassword', async () => {
    reset({ password: undefined, googleUid: 'g-1' });
    const r = await call({ password: 'first-password-1' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(doc.password, 'first-password-1');
    assert.strictEqual(doc.matchChecks, 0, 'there was nothing to compare against');
    assert.ok(r.body.data.token);
  });

  await t('E: a Google-linked account that HAS a password is protected the same way', async () => {
    reset({ googleUid: 'g-1' });
    const r = await call({ password: 'brand-new-pass' });
    assert.strictEqual(r.body.code, 'CURRENT_PASSWORD_REQUIRED');
    untouched();
  });

  await t('F: non-string currentPassword (object / array / number) → 400 required, never a 500 or a bypass', async () => {
    for (const bad of [{ $ne: 'x' }, ['a'], 12345678, true, null, '']) {
      reset();
      const r = await call({ password: 'brand-new-pass', currentPassword: bad });
      assert.strictEqual(r.status, 400, `currentPassword=${JSON.stringify(bad)} → ${r.status}`);
      assert.strictEqual(r.body.code, 'CURRENT_PASSWORD_REQUIRED');
      untouched();
    }
  });

  await t('G: other profile edits never need currentPassword (regression); a stray currentPassword is ignored', async () => {
    reset();
    const r1 = await call({ name: 'Asha K', vegOnly: true });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(doc.name, 'Asha K');
    assert.strictEqual(doc.tokenVersion, 3, 'a non-password edit must not revoke sessions');
    assert.ok(!r1.body.data.token);
    reset();
    const r2 = await call({ name: 'Asha', currentPassword: 'whatever' });
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(doc.matchChecks, 0);
  });

  await t('H: a too-short new password is still rejected (existing rule) and changes nothing', async () => {
    reset();
    const r = await call({ password: 'short', currentPassword: OLD });
    assert.strictEqual(r.status, 400);
    untouched();
  });

  await t('I: PUT /profile has a per-account limiter that only counts password-change attempts', async () => {
    const route = routes.find(r => r.method === 'put' && r.path === '/profile');
    assert.ok(route, 'PUT /profile not routed');
    const lim = route.handlers.find(h => typeof h === 'function' && Object.prototype.hasOwnProperty.call(h, 'opts') && typeof h.opts.keyGenerator === 'function');
    assert.ok(lim, 'PUT /profile has no per-account limiter');
    const o = lim.opts;
    assert.ok(o.max <= 10 && o.windowMs >= 10 * 60 * 1000, `too loose: ${o.max}/${o.windowMs}ms`);
    assert.strictEqual(o.skipSuccessfulRequests, true, 'a successful change must not use up the budget');
    assert.strictEqual(o.keyGenerator({ user: { _id: 'U1' }, ip: '1.1.1.1' }), 'U1');
    assert.notStrictEqual(o.keyGenerator({ user: { _id: 'U2' }, ip: '1.1.1.1' }), o.keyGenerator({ user: { _id: 'U1' }, ip: '1.1.1.1' }));
    assert.strictEqual(o.skip({ body: { name: 'x' } }), true, 'name/avatar edits must not use up the budget');
    assert.strictEqual(o.skip({ body: {} }), true);
    assert.strictEqual(o.skip({ body: { password: 'brand-new-pass' } }), false, 'password attempts must be counted');
    const order = route.handlers.indexOf(lim);
    assert.ok(order > 0, 'limiter must run after protect so req.user exists');
  });

  await t('J: the PUT /profile validator accepts a currentPassword field', async () => {
    const src = fs.readFileSync(ROUTES, 'utf8');
    assert.ok(/body\('currentPassword'\)/.test(src), 'no currentPassword validation on the route');
  });

  realLog(`profile-password-change: ${pass} scenarios passed`);
})().catch((e) => { console.log = realLog; console.error('FAIL', e.message); process.exit(1); });

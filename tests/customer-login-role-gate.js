// Regression test: POST /api/users/login is a CUSTOMER login. Only role "user" gets a token here.
// Before: any account with the right password got a JWT, so admin / vendor / rider credentials
// could be used on this endpoint, skipping vendorLogin's restaurant-approval check and the admin /
// rider login limiters (an extra place to guess staff passwords). Now staff accounts get the SAME
// 401 as a wrong password (no token, nothing saved), so the endpoint does not reveal which
// identifiers belong to staff; a server log line records the attempt.
// Runs with no database (in-memory fakes). Usage: npm run test:customer-login-role-gate
const Module = require('module');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const CONTROLLER = path.join(ROOT, 'controllers/userController.js');

// ── in-memory User model ─────────────────────────────────────────────────────────
const users = [];
const PASSWORD = 'correct-horse';
let ids = 0;
const seed = (over) => {
  const doc = {
    _id: 'U' + (++ids), role: 'user', isActive: true, password: 'hashed', saves: 0, lastLogin: null,
    async matchPassword(pw) { return pw === PASSWORD; },
    async save() { this.saves++; return this; },
    toJSON() { const { matchPassword, save, toJSON, password, ...rest } = this; return rest; },
    ...over,
  };
  users.push(doc);
  return doc;
};
const User = {
  findOne(filter) {
    const found = users.find(u => Object.entries(filter).every(([k, v]) => u[k] === v)) || null;
    return { select() { return Promise.resolve(found); } };
  },
};
const tokens = [];
const stubs = {
  [path.join(ROOT, 'models/User.js')]: User,
  [path.join(ROOT, 'models/Address.js')]: {},
  [path.join(ROOT, 'utils/generateToken.js')]: (id, role) => { tokens.push({ id, role }); return 'jwt-' + id; },
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
const { login } = require(CONTROLLER);
Module._load = origLoad;
const realLog = console.log; const realWarn = console.warn;
const logged = [];
console.log = () => {}; console.warn = (...a) => { logged.push(a.join(' ')); };

const call = async (body) => {
  const out = {};
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; if (!out.status) out.status = 200; return res; } };
  let err = null;
  await login({ body }, res, (e) => { err = e; });
  if (err) throw err;
  return out;
};
const reset = () => { users.length = 0; tokens.length = 0; logged.length = 0; ids = 0; };

(async () => {
  let pass = 0;
  const t = async (name, fn) => {
    reset();
    try { await fn(); } catch (e) { console.log = realLog; console.error('FAIL', name, '-', e.message); process.exit(1); }
    pass++; realLog('PASS', name);
  };
  const STAFF = ['admin', 'vendor', 'rider'];
  const r_json = (r) => r.body.data.user;
  const WRONG = { status: 401, body: { success: false, message: 'Invalid email/mobile number or password.' } };

  await t('A: admin / vendor / rider with the CORRECT password → 401, no token, nothing saved', async () => {
    for (const role of STAFF) {
      const u = seed({ role, email: `${role}@x.com`, phone: '90000000' + (STAFF.indexOf(role) + 1) });
      const r = await call({ identifier: u.email, password: PASSWORD });
      assert.strictEqual(r.status, 401, `${role} got ${r.status}`);
      assert.strictEqual(u.saves, 0, `${role}: account was saved/updated`);
      assert.strictEqual(u.lastLogin, null);
    }
    assert.strictEqual(tokens.length, 0, 'a token was minted for staff');
  });

  await t('B: staff rejection is byte-identical to a wrong password and to an unknown account (no oracle)', async () => {
    const staff = seed({ role: 'admin', email: 'a@x.com' });
    const customer = seed({ role: 'user', email: 'c@x.com' });
    const staffOk = await call({ identifier: staff.email, password: PASSWORD });
    const staffBad = await call({ identifier: staff.email, password: 'nope' });
    const custBad = await call({ identifier: customer.email, password: 'nope' });
    const unknown = await call({ identifier: 'nobody@x.com', password: PASSWORD });
    for (const r of [staffOk, staffBad, custBad, unknown]) assert.deepStrictEqual(r, WRONG);
  });

  await t('C: a customer logs in by email and by phone (regression) and gets a token', async () => {
    const u = seed({ role: 'user', email: 'c@x.com', phone: '9111111111' });
    const byEmail = await call({ identifier: 'C@X.com', password: PASSWORD });
    const byPhone = await call({ identifier: '9111111111', password: PASSWORD });
    for (const r of [byEmail, byPhone]) {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.success, true);
      assert.strictEqual(r.body.data.token, 'jwt-' + u._id);
    }
    assert.strictEqual(tokens.length, 2);
    assert.ok(u.lastLogin instanceof Date && u.saves === 2);
    assert.ok(!('password' in r_json(byEmail)), 'password leaked in response');
  });
  await t('D: legacy customer documents with no role field still log in', async () => {
    seed({ role: undefined, email: 'old@x.com' });
    const r = await call({ identifier: 'old@x.com', password: PASSWORD });
    assert.strictEqual(r.status, 200);
  });

  await t('E: disabled customer → 403 (unchanged); disabled STAFF → plain 401 (no disclosure)', async () => {
    seed({ role: 'user', email: 'off@x.com', isActive: false });
    seed({ role: 'vendor', email: 'v@x.com', isActive: false });
    assert.strictEqual((await call({ identifier: 'off@x.com', password: PASSWORD })).status, 403);
    assert.deepStrictEqual(await call({ identifier: 'v@x.com', password: PASSWORD }), WRONG);
  });

  await t('F: a staff attempt with a correct password is logged (role + id, never the password or identifier)', async () => {
    const u = seed({ role: 'rider', email: 'rider@x.com' });
    await call({ identifier: u.email, password: PASSWORD });
    const line = logged.find(l => /staff/i.test(l));
    assert.ok(line, 'no log line for the staff attempt');
    assert.ok(line.includes('rider') && line.includes(u._id));
    assert.ok(!line.includes(PASSWORD) && !line.includes(u.email), 'log leaks the password or identifier');
  });

  await t('G: static — the query still selects +password, and no staff token path remains', async () => {
    const src = fs.readFileSync(CONTROLLER, 'utf8');
    const body = src.slice(src.indexOf('const login = asyncHandler'), src.indexOf('const requestEmailPasswordReset'));
    assert.ok(body.length > 300, 'could not isolate login');
    assert.ok(/\.select\(['"][^'"]*\+password/.test(body), 'login no longer selects +password');
    assert.ok(/role\s*\|\|\s*['"]user['"]\)\s*!==\s*['"]user['"]/.test(body), 'login has no customer-only role check');
  });

  realLog(`customer-login-role-gate: ${pass} scenarios passed`);
})().catch((e) => { console.log = realLog; console.error('FAIL', e.message); process.exit(1); });

// Regression test: GET /vendor-applications/:id/status must never crash on a missing/malformed token hash.
// Before: customer-owned applications are created with statusTokenHash undefined, and the status endpoint
// ran crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(application.statusTokenHash)) which throws
// (TypeError on a missing hash, RangeError on a length mismatch) -> a 500 instead of a plain 404, and a
// different answer for "id exists" vs "id does not exist". Now every non-match is the same 404.
// Runs with no database (in-memory fakes). Usage: npm run test:vendor-application-status
const Module = require('module');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const CONTROLLER = path.join(ROOT, 'controllers/vendorApplicationController.js');

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const apps = new Map();
const VendorApplication = {
  findById: (id) => {
    const q = { select() { return q; }, then(res, rej) { return Promise.resolve(apps.get(String(id)) || null).then(res, rej); } };
    return q;
  },
};
const stubs = {
  [path.join(ROOT, 'models/VendorApplication.js')]: VendorApplication,
  'express-async-handler': (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
  mongoose: { isValidObjectId: (v) => typeof v === 'string' && /^[a-f\d]{24}$/i.test(v) },
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
const { getVendorApplicationStatus } = require(CONTROLLER);
Module._load = origLoad;
const realLog = console.log; console.log = () => {};

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const FUTURE = new Date(Date.now() + 3600e3);
const mk = (extra) => ({ _id: ID, status: 'pending', restaurantName: 'Tasty', ownerName: 'Owner', createdAt: new Date(), ...extra });
const call = async (req) => {
  const out = { nextErr: null };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; if (!out.status) out.status = 200; return res; } };
  await Promise.race([
    getVendorApplicationStatus({ params: { id: ID }, body: {}, query: {}, ...req }, res, (e) => { out.nextErr = e || new Error('next()'); }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('handler hung')), 500)),
  ]);
  return out;
};
const expect404 = (r, label) => {
  assert.strictEqual(r.nextErr, null, `${label}: handler threw (${r.nextErr && r.nextErr.message})`);
  assert.strictEqual(r.status, 404, `${label}: expected 404, got ${r.status}`);
  assert.deepStrictEqual(r.body, { success: false, message: 'Application not found.' }, `${label}: body differs`);
};

(async () => {
  let pass = 0;
  const t = async (name, fn) => { apps.clear(); await fn(); pass++; realLog('PASS', name); };

  await t('A: correct token (body or query) returns the public application', async () => {
    apps.set(ID, mk({ statusTokenHash: sha('tok123'), statusTokenExpiresAt: FUTURE }));
    for (const req of [{ body: { statusToken: 'tok123' } }, { query: { statusToken: ' tok123 ' } }]) {
      const r = await call(req);
      assert.strictEqual(r.nextErr, null);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.data.status, 'pending');
      assert.strictEqual(r.body.data.restaurantName, 'Tasty');
      assert.ok(!('statusTokenHash' in r.body.data));
    }
  });

  await t('B: customer-owned application with NO token hash -> plain 404, no crash', async () => {
    apps.set(ID, mk({ statusTokenHash: undefined, statusTokenExpiresAt: undefined }));
    expect404(await call({ body: { statusToken: 'anything' } }), 'undefined hash');
    apps.set(ID, mk({ statusTokenHash: null, statusTokenExpiresAt: FUTURE }));
    expect404(await call({ body: { statusToken: 'anything' } }), 'null hash');
    apps.set(ID, mk({ statusTokenHash: '', statusTokenExpiresAt: FUTURE }));
    expect404(await call({ body: { statusToken: 'anything' } }), 'empty hash');
  });

  await t('C: malformed stored hash (wrong length / not a string) -> plain 404, no crash', async () => {
    for (const bad of ['abc', 'x'.repeat(65), 12345, {}, ['a']]) {
      apps.set(ID, mk({ statusTokenHash: bad, statusTokenExpiresAt: FUTURE }));
      expect404(await call({ body: { statusToken: 'anything' } }), `hash ${JSON.stringify(bad)}`);
    }
  });

  await t('D: wrong token -> 404; a missing id looks identical', async () => {
    apps.set(ID, mk({ statusTokenHash: sha('tok123'), statusTokenExpiresAt: FUTURE }));
    const wrong = await call({ body: { statusToken: 'nope' } });
    expect404(wrong, 'wrong token');
    apps.clear();
    const missing = await call({ body: { statusToken: 'nope' } });
    expect404(missing, 'missing application');
    assert.deepStrictEqual(wrong, missing);
  });

  await t('E: expired token -> 410 (even with the right token); bad id / no token -> 400', async () => {
    apps.set(ID, mk({ statusTokenHash: sha('tok123'), statusTokenExpiresAt: new Date(Date.now() - 1000) }));
    const r = await call({ body: { statusToken: 'tok123' } });
    assert.strictEqual(r.status, 410);
    apps.set(ID, mk({ statusTokenHash: sha('tok123'), statusTokenExpiresAt: FUTURE }));
    assert.strictEqual((await call({ params: { id: 'not-an-id' }, body: { statusToken: 'tok123' } })).status, 400);
    assert.strictEqual((await call({ body: {} })).status, 400);
    assert.strictEqual((await call({ body: { statusToken: '   ' } })).status, 400);
  });

  realLog(`\n${pass} scenarios passed`);
})().catch((e) => { realLog('FAIL', e && e.message ? e.message : e); process.exit(1); });

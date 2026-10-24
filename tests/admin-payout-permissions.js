// Regression test: payout-request admin routes must require the 'finance.manage'
// permission. Before the fix any admin account — including a limited-permission
// staff account — could list payouts, read reconciliation data and mark payouts
// paid / rejected. The real routes/adminRoutes.js is loaded with a recording
// router, then every payout route's middleware chain is executed with fake admins.
// No database, no Express. Usage: npm run test:admin-payout-permissions
const Module = require('module');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');

const routes = []; // { method, path, handlers: [] }
const fakeRouter = () => {
  const r = {};
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) r[m] = (p, ...handlers) => { routes.push({ method: m, path: p, handlers }); return r; };
  r.use = () => r;
  return r;
};
const expressStub = Object.assign(() => ({}), { Router: fakeRouter, json: () => (q, s, n) => n && n() });
const reached = [];
const controllerStub = () => new Proxy({}, { get: (_t, name) => { const fn = (req, res) => { reached.push(String(name)); res.json({ success: true }); }; fn.handlerName = String(name); return fn; } });
const passThrough = (_req, _res, next) => next();
const stubs = {
  express: expressStub,
  'express-rate-limit': () => passThrough,
  [path.join(ROOT, 'middleware/authMiddleware.js')]: { protect: passThrough, authorize: () => passThrough },
  [path.join(ROOT, 'controllers/adminController.js')]: controllerStub(),
  [path.join(ROOT, 'controllers/adminMarketplaceController.js')]: controllerStub(),
  [path.join(ROOT, 'controllers/vendorApplicationController.js')]: controllerStub(),
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { if (stubs[req]) return req; return origResolve.call(this, req, parent, ...rest); };
for (const [k, v] of Object.entries(stubs)) require.cache[k] = { id: k, filename: k, loaded: true, exports: v };
require(path.join(ROOT, 'routes/adminRoutes.js'));

// Run a route's middleware chain like Express would, with a fake request.
const run = async (route, user) => {
  reached.length = 0;
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  const req = { user, params: { id: 'p1' }, query: {}, body: {} };
  for (const h of route.handlers) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return { code: res.code, reached: reached.length > 0 };
};
const admin = (permissions) => ({ role: 'admin', permissions });

const payoutRoutes = routes.filter(r => /payout/i.test(r.path));

(async () => {
  let pass = 0;
  const t = async (name, fn) => { await fn(); pass++; console.log('PASS', name); };

  await t('the three payout routes exist (list, reconciliation, update)', async () => {
    assert.deepStrictEqual(payoutRoutes.map(r => `${r.method} ${r.path}`).sort(), [
      'get /payout-requests', 'get /payout-requests/:id/reconciliation', 'patch /payout-requests/:id',
    ]);
  });

  await t('A: a limited admin WITHOUT finance.manage is refused on every payout route (403, handler never runs)', async () => {
    for (const r of payoutRoutes) {
      for (const perms of [['support.manage'], ['orders.manage', 'reviews.moderate']]) {
        const out = await run(r, admin(perms));
        assert.strictEqual(out.code, 403, `${r.method} ${r.path} with ${perms}`);
        assert.strictEqual(out.reached, false, `${r.method} ${r.path} handler must not run`);
      }
    }
  });

  await t('B: an admin WITH finance.manage can use every payout route', async () => {
    for (const r of payoutRoutes) {
      const out = await run(r, admin(['finance.manage']));
      assert.strictEqual(out.code, 200, `${r.method} ${r.path}`);
      assert.strictEqual(out.reached, true);
    }
  });

  await t('C: legacy full admin (empty permissions list) keeps working', async () => {
    for (const r of payoutRoutes) {
      const out = await run(r, admin([]));
      assert.strictEqual(out.code, 200, `${r.method} ${r.path}`);
      assert.strictEqual(out.reached, true);
    }
  });

  await t('D: a non-admin account is refused on every payout route', async () => {
    for (const r of payoutRoutes) {
      const out = await run(r, { role: 'vendor', permissions: ['finance.manage'] });
      assert.strictEqual(out.code, 403);
      assert.strictEqual(out.reached, false);
    }
  });

  console.log(`\n${pass} scenarios passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });

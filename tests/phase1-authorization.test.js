'use strict';
// Phase 1 authorization regression tests. Dependency-free (no Mongo, no network):
// real middleware/routes/controllers are loaded; only third-party packages and
// models/services are replaced by stubs. Usage: node tests/phase1-authorization.test.js
const Module = require('module');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');

const passThrough = (_q, _s, n) => n && n();
const universal = () => new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : universal()), apply: () => universal(), construct: () => ({}) });
const fakeUsers = []; // in-memory User store used by controller tests
let bootstrapClaimed = false;
const FakeAdminSetupClaim = {
  create: async ({ _id }) => { if (bootstrapClaimed) throw Object.assign(new Error('duplicate key'), { code: 11000 }); bootstrapClaimed = true; return { _id }; },
  deleteOne: async () => { bootstrapClaimed = false; return { deletedCount: 1 }; },
};
const FakeUser = {
  findOne: async (q) => fakeUsers.find((u) => (q.role ? u.role === q.role : true) && (!q.$or || q.$or.some((c) => Object.entries(c).every(([k, v]) => u[k] === v)))) || null,
  create: async (doc) => { const u = { _id: `u${fakeUsers.length + 1}`, ...doc }; fakeUsers.push(u); return u; },
  findById: (id) => ({ select: async () => { const u = fakeUsers.find((x) => x._id === id); if (!u) return null; u.save = async () => { u.saved = true; }; return u; } }),
};
const audit = [];
let routeSink = null;
const recRouter = () => { const r = {}; for (const m of ['get', 'post', 'put', 'patch', 'delete']) r[m] = (p, ...h) => { routeSink.push({ method: m.toUpperCase(), path: p, handlers: h.flat(Infinity) }); return r; }; r.use = () => r; return r; };
const real = new Set(['middleware/permissionMiddleware.js', 'middleware/roleMiddleware.js', 'controllers/setupController.js', 'controllers/adminController.js']);
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (request === 'express') return Object.assign(() => ({}), { Router: recRouter, json: () => passThrough });
  if (request === 'express-rate-limit') return () => passThrough;
  if (request === 'express-async-handler') return (fn) => fn;
  if (request === 'multer') { const m = () => ({ single: () => passThrough, array: () => passThrough, fields: () => passThrough }); m.memoryStorage = m.diskStorage = () => ({}); m.MulterError = class MulterError extends Error {}; return m; }
  if (request.startsWith('.') && parent) {
    const rel = path.relative(ROOT, path.resolve(path.dirname(parent.filename), request)).replace(/\\/g, '/');
    if (/^utils\/riderUpload$/.test(rel)) return { upload: { single: () => passThrough } };
    if (/^middleware\/uploadMiddleware$/.test(rel)) return { single: () => passThrough };
    if (/^middleware\/customerMediaUpload$/.test(rel)) return { array: () => passThrough };
    if (/^middleware\/authMiddleware/.test(rel)) return { protect: passThrough, optionalAuth: passThrough, authorize: (...roles) => (req, res, next) => (req.user && roles.includes(req.user.role) ? next() : res.status(403).json({ success: false })) };
    if (/^models\/User$/.test(rel)) return FakeUser;
    if (/^models\/AdminSetupClaim$/.test(rel)) return FakeAdminSetupClaim;
    if (/^services\/auditService$/.test(rel)) return { logAdminAction: async (_r, e) => { audit.push(e); } };
    if (/^(controllers|models|services|utils)\//.test(rel) && !real.has(rel + '.js') && !real.has(rel)) {
      if (/^controllers\//.test(rel)) return new Proxy({}, { get: (_t, name) => { const f = (req, res) => { reached.push(String(name)); res.json({ success: true }); }; return f; } });
      return universal();
    }
  }
  if (['mongoose', 'express-validator', 'jsonwebtoken', 'bcryptjs'].includes(request)) return universal();
  return origLoad.apply(this, arguments);
};
const reached = [];
const mkRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } });
// Runs every middleware before the final handler. `reached` is non-empty only if all of
// them called next(), i.e. the request would have been handed to the route handler.
const runChain = async (handlers, req) => { const res = mkRes(); const gates = handlers.slice(0, -1); let open = true; for (const h of gates) { let adv = false; await h(req, res, () => { adv = true; }); if (!adv) { open = false; break; } } return { res, reached: open ? ['handler'] : [] }; };
const loadRoutes = (file, env = {}) => {
  const saved = {}; for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  const f = path.join(ROOT, 'routes', file); delete require.cache[f]; routeSink = [];
  require(f); for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  return routeSink;
};

const { requirePermission, requirePermissionForAdmin, requireFullAdmin, isFullAdmin } = require('../middleware/permissionMiddleware');
let passed = 0, failed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, '\n    ', e.message); } };
const call = (mw, user) => { const res = mkRes(); let nexted = false; mw({ user }, res, () => { nexted = true; }); return { code: res.code, nexted }; };

(async () => {
  // ---- permission policy -------------------------------------------------
  const mw = requirePermission('finance.manage');
  await t('full admin (["*"]) is allowed', () => assert.deepStrictEqual(call(mw, { role: 'admin', permissions: ['*'] }), { code: 200, nexted: true }));
  await t('authorized staff (has required permission) is allowed', () => assert.strictEqual(call(mw, { role: 'admin', permissions: ['support.manage', 'finance.manage'] }).nexted, true));
  await t('unauthorized staff (other permissions only) gets 403, no next()', () => assert.deepStrictEqual(call(mw, { role: 'admin', permissions: ['support.manage'] }), { code: 403, nexted: false }));
  for (const [label, perms] of [['empty array', []], ['null', null], ['string', 'finance.manage'], ['object', { 'finance.manage': true }], ['array with non-string', ['finance.manage', 7]], ['array with empty string', ['']], ['number', 1], ['nested array', [['*']]]]) {
    await t(`malformed/empty permissions (${label}) fail closed`, () => assert.deepStrictEqual(call(mw, { role: 'admin', permissions: perms }), { code: 403, nexted: false }));
  }
  await t('missing permissions field fails closed', () => assert.deepStrictEqual(call(mw, { role: 'admin' }), { code: 403, nexted: false }));
  for (const role of ['vendor', 'rider', 'user', 'ceo', 'superadmin', undefined, null, 'ADMIN']) {
    await t(`unknown/non-admin role (${role}) is refused even with ["*"]`, () => assert.deepStrictEqual(call(mw, { role, permissions: ['*'] }), { code: 403, nexted: false }));
  }
  await t('no req.user is refused', () => assert.strictEqual(call(mw, undefined).code, 403));
  await t('route naming no permission cannot be satisfied by restricted staff', () => assert.strictEqual(call(requirePermission(), { role: 'admin', permissions: ['finance.manage'] }).code, 403));
  await t('requirePermissionForAdmin preserves vendor route access but gates admin callers', () => {
    assert.strictEqual(call(requirePermissionForAdmin('restaurants.manage'), { role: 'admin', permissions: ['settings.manage'] }).code, 403);
    assert.strictEqual(call(requirePermissionForAdmin('restaurants.manage'), { role: 'admin', permissions: ['restaurants.manage'] }).nexted, true);
    assert.strictEqual(call(requirePermissionForAdmin('restaurants.manage'), { role: 'admin', permissions: ['*'] }).nexted, true);
    assert.strictEqual(call(requirePermissionForAdmin('restaurants.manage'), { role: 'vendor', restaurantId: 'owned' }).nexted, true);
  });
  await t('requireFullAdmin: staff with settings.manage refused, full admin allowed', () => {
    assert.strictEqual(call(requireFullAdmin, { role: 'admin', permissions: ['settings.manage'] }).code, 403);
    assert.strictEqual(call(requireFullAdmin, { role: 'admin', permissions: [] }).code, 403);
    assert.strictEqual(call(requireFullAdmin, { role: 'vendor', permissions: ['*'] }).code, 403);
    assert.strictEqual(call(requireFullAdmin, { role: 'admin', permissions: ['*'] }).nexted, true);
    assert.strictEqual(isFullAdmin({ role: 'admin', permissions: 'x' }), false);
  });

  // ---- every permission-gated route, through the real route files ---------
  const gated = [];
  const routeFiles = ['adminRoutes.js', 'settlementRoutes.js', 'platformRoutes.js', 'couponRoutes.js', 'analyticsRoutes.js', 'restaurantRoutes.js', 'authRoutes.js', 'categoryRoutes.js', 'homeBannerRoutes.js', 'menuRoutes.js', 'notificationRoutes.js', 'adminRiderRoutes.js', 'orderRoutes.js', 'uploadRoutes.js', 'vendorApplicationRoutes.js', 'privacyRoutes.js'];
  const runtimeRouteFiles = routeFiles.filter((f) => f !== 'privacyRoutes.js'); // validation chains are separately covered by source-level permission inventory below
  for (const f of runtimeRouteFiles) {
    for (const r of loadRoutes(f)) if (r.handlers.length > 1 && r.handlers.some((h) => h.length === 3 && /requirePermission|permission/i.test(String(h)) && !String(h).includes("req.user?.role !== 'admin'"))) gated.push({ file: f, ...r });
  }
  await t('permission-gated routes were discovered (sanity)', () => assert.ok(gated.length >= 30, `found ${gated.length}`));
  await t('no gated route reaches its handler for empty/missing/malformed/insufficient admins', async () => {
    for (const r of gated) for (const user of [{ role: 'admin', permissions: [] }, { role: 'admin' }, { role: 'admin', permissions: 'x' }, { role: 'admin', permissions: ['not.a.real.permission'] }, { role: 'vendor', permissions: ['*'] }]) {
      const out = await runChain(r.handlers, { user, params: { id: 'x' }, query: {}, body: {} });
      assert.strictEqual(out.res.code, 403, `${r.file} ${r.method} ${r.path} as ${JSON.stringify(user)}`);
      assert.strictEqual(out.reached.length, 0, `${r.file} ${r.method} ${r.path} handler ran`);
    }
  });
  await t('every admin-only route registration has an explicit permission/full-admin gate', () => {
    const fs = require('fs');
    const files = routeFiles;
    const misses = [];
    for (const file of files) {
      const src = fs.readFileSync(path.join(ROOT, 'routes', file), 'utf8');
      const statements = src.match(/router\.(?:get|post|put|patch|delete)\([\s\S]*?\);/g) || [];
      for (const statement of statements) {
        if (/authorize\(\s*['\"]admin['\"]/.test(statement) && !/requirePermission(?:ForAdmin)?\s*(?:\(|,)|requireFullAdmin\s*(?:\(|,)/.test(statement)) misses.push(`${file}: ${statement.split('\n')[0].trim()}`);
      }
      if (file === 'adminRiderRoutes.js') {
        for (const statement of statements) if (!/requirePermission\('riders\.manage'\)/.test(statement)) misses.push(`${file}: rider admin route lacks riders.manage gate: ${statement.split('\n')[0].trim()}`);
      }
    }
    assert.deepStrictEqual(misses, [], misses.join('\n'));
  });
  await t('every gated route admits a full admin and reaches its handler', async () => {
    for (const r of gated) { const out = await runChain(r.handlers, { user: { role: 'admin', permissions: ['*'] }, params: { id: 'x' }, query: {}, body: {} }); assert.strictEqual(out.reached.length, 1, `${r.file} ${r.method} ${r.path}`); }
  });
  const adminRoutes = loadRoutes('adminRoutes.js');
  const permRoute = adminRoutes.find((r) => r.method === 'PATCH' && r.path === '/admins/:id/permissions');
  await t('PATCH /admins/:id/permissions: restricted staff with settings.manage cannot reach handler (privilege escalation closed)', async () => {
    const out = await runChain(permRoute.handlers, { user: { role: 'admin', permissions: ['settings.manage'] }, params: { id: 'a2' }, body: { permissions: [] } });
    assert.strictEqual(out.res.code, 403); assert.strictEqual(out.reached.length, 0);
  });

  // ---- updateAdminPermissions handler (real controller, fake User) --------
  const admin = require('../controllers/adminController');
  const callHandler = async (user, id, body) => { const res = mkRes(); await admin.updateAdminPermissions({ user, params: { id }, body }, res); return res; };
  fakeUsers.length = 0; fakeUsers.push({ _id: 'staff1', role: 'admin', email: 's@x.test', permissions: ['support.manage'] }, { _id: 'cust1', role: 'user', permissions: [] });
  const full = { _id: 'root', role: 'admin', permissions: ['*'] };
  await t('handler refuses restricted caller even if routing were bypassed; target unchanged', async () => {
    const res = await callHandler({ _id: 'x', role: 'admin', permissions: ['settings.manage'] }, 'staff1', { permissions: [] });
    assert.strictEqual(res.code, 403); assert.deepStrictEqual(fakeUsers[0].permissions, ['support.manage']); assert.ok(!fakeUsers[0].saved);
  });
  for (const [label, body] of [['missing body', undefined], ['non-array', { permissions: 'finance.manage' }], ['unknown permission', { permissions: ['finance.manage', 'bogus'] }], ['"*" via API', { permissions: ['*'] }], ['non-string member', { permissions: [1] }]]) {
    await t(`handler rejects ${label} with 400 and no mutation`, async () => {
      const res = await callHandler(full, 'staff1', body);
      assert.strictEqual(res.code, 400); assert.deepStrictEqual(fakeUsers[0].permissions, ['support.manage']); assert.ok(!fakeUsers[0].saved);
    });
  }
  await t('handler: full admin can set a valid de-duplicated list; audit entry written', async () => {
    const res = await callHandler(full, 'staff1', { permissions: ['finance.manage', 'finance.manage', 'orders.manage'] });
    assert.strictEqual(res.code, 200); assert.deepStrictEqual(fakeUsers[0].permissions, ['finance.manage', 'orders.manage']); assert.strictEqual(audit.at(-1).action, 'admin.permissions.update');
  });
  await t('handler: cannot modify own permissions; cannot target non-admin accounts', async () => {
    assert.strictEqual((await callHandler(full, 'root', { permissions: ['finance.manage'] })).code, 400);
    const res = await callHandler(full, 'cust1', { permissions: ['finance.manage'] });
    assert.strictEqual(res.code, 404); assert.deepStrictEqual(fakeUsers[1].permissions, []);
  });

  // ---- bootstrap/setup route --------------------------------------------
  await t('setup route is NOT registered unless ENABLE_ADMIN_SETUP=true', () => {
    assert.ok(!loadRoutes('authRoutes.js', { ENABLE_ADMIN_SETUP: undefined }).some((r) => r.path === '/setup-admin'));
    assert.ok(!loadRoutes('authRoutes.js', { ENABLE_ADMIN_SETUP: 'false' }).some((r) => r.path === '/setup-admin'));
    assert.ok(loadRoutes('authRoutes.js', { ENABLE_ADMIN_SETUP: 'true' }).some((r) => r.path === '/setup-admin'));
  });
  const { setupAdmin } = require('../controllers/setupController');
  const setup = async (headers, body) => { const res = mkRes(); await setupAdmin({ get: (h) => headers[h.toLowerCase()], body }, res); return res; };
  const goodBody = { name: 'Root', email: 'root@test.invalid', phone: '+919999999999', password: 'a-very-long-test-password' };
  fakeUsers.length = 0; delete process.env.ADMIN_SETUP_KEY;
  await t('setup: no ADMIN_SETUP_KEY configured -> 503, nothing created', async () => { assert.strictEqual((await setup({ 'x-setup-key': 'k' }, goodBody)).code, 503); assert.strictEqual(fakeUsers.length, 0); });
  process.env.ADMIN_SETUP_KEY = 'test-setup-key-not-a-secret';
  await t('setup: wrong / missing / different-length key -> 403, nothing created', async () => {
    for (const k of ['wrong', '', 'test-setup-key-not-a-secreT', 'x'.repeat(500)]) assert.strictEqual((await setup({ 'x-setup-key': k }, goodBody)).code, 403);
    assert.strictEqual(fakeUsers.length, 0);
  });
  await t('setup: correct key creates exactly one admin with explicit full-access permission; password not echoed', async () => {
    const res = await setup({ 'x-setup-key': 'test-setup-key-not-a-secret' }, { ...goodBody, role: 'vendor', permissions: ['x'] });
    assert.strictEqual(res.code, 201); assert.strictEqual(fakeUsers.length, 1);
    assert.strictEqual(fakeUsers[0].role, 'admin'); assert.deepStrictEqual(fakeUsers[0].permissions, ['*']);
    assert.ok(!JSON.stringify(res.body).includes(goodBody.password));
  });
  await t('setup: second attempt with correct key -> 409, still one admin', async () => {
    assert.strictEqual((await setup({ 'x-setup-key': 'test-setup-key-not-a-secret' }, { ...goodBody, email: 'b@test.invalid', phone: '+919888888888' })).code, 409);
    assert.strictEqual(fakeUsers.filter((u) => u.role === 'admin').length, 1);
  });
  await t('setup: concurrent valid bootstrap attempts create at most one admin', async () => {
    fakeUsers.length = 0; bootstrapClaimed = false;
    const [a, b] = await Promise.all([
      setup({ 'x-setup-key': 'test-setup-key-not-a-secret' }, { ...goodBody, email: 'a@test.invalid', phone: '+919999999998' }),
      setup({ 'x-setup-key': 'test-setup-key-not-a-secret' }, { ...goodBody, email: 'b@test.invalid', phone: '+919999999997' }),
    ]);
    assert.deepStrictEqual([a.code, b.code].sort(), [201, 409]);
    assert.strictEqual(fakeUsers.filter((u) => u.role === 'admin').length, 1);
  });

  // ---- alternate access paths: both prefixes -----------------------------
  await t('server.js mounts every router under both /api and /api/v1', () => {
    const src = require('fs').readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.ok(/app\.use\(`\/api\$\{path\}`, router\)/.test(src) && /app\.use\(`\/api\/v1\$\{path\}`, router\)/.test(src));
    const mounts = [...src.matchAll(/^\s*\['(\/[\w-/]+)',\s*\w+\],?/gm)].map((m) => m[1]);
    assert.ok(mounts.includes('/admin') && mounts.includes('/auth') && mounts.length >= 25, `mounts: ${mounts.length}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

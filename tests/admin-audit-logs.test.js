// Regression test: the admin audit trail must be READABLE, full-admin only,
// filterable and paginated. Loads the real controller and the real route table
// with stubs (no database, no Express). Usage: npm run test:admin-audit-logs
const Module = require('module');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');

let lastFind = null;
const docs = Array.from({ length: 57 }, (_, i) => ({
  _id: `id${i}`, createdAt: new Date(2026, 9, 1, 0, i), actor: 'a1', actorName: 'Root Admin',
  action: i % 2 ? 'restaurant.commission.update' : 'admin.permissions.update',
  targetType: 'restaurant', targetId: null, targetLabel: `R${i}`,
  oldValue: { v: i }, newValue: { v: i + 1 }, ip: '1.2.3.4', userAgent: 'secret-agent',
}));
const modelStub = {
  find(filter) {
    lastFind = { filter };
    const q = { sort() { return q; }, skip(n) { lastFind.skip = n; return q; }, limit(n) { lastFind.limit = n; return q; },
      lean: async () => docs.slice(lastFind.skip, lastFind.skip + lastFind.limit) };
    return q;
  },
  countDocuments: async () => docs.length,
};
const routes = [];
const fakeRouter = () => { const r = {}; for (const m of ['get', 'post', 'put', 'patch', 'delete']) r[m] = (p, ...h) => { routes.push({ method: m, path: p, handlers: h }); return r; }; r.use = () => r; return r; };
const pass = (_q, _s, n) => n && n();
const proxyCtl = () => new Proxy({}, { get: (_t, name) => Object.assign((_q, s) => s.json({ ok: true }), { handlerName: String(name) }) });

const real = new Map();
const stubs = {
  mongoose: { Types: { ObjectId: { isValid: (v) => /^[a-f0-9]{24}$/i.test(String(v)) } } },
  'express-async-handler': (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
  express: Object.assign(() => ({}), { Router: fakeRouter, json: () => pass }),
  'express-rate-limit': () => pass,
};
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (stubs[request]) return stubs[request];
  const resolved = (() => { try { return Module._resolveFilename(request, parent); } catch { return ''; } })();
  if (resolved === path.join(ROOT, 'models/AdminAuditLog.js')) return modelStub;
  if (parent && /routes[\\/]adminRoutes\.js$/.test(parent.filename) && /controllers[\\/]/.test(request) && !/adminAuditController/.test(request)) return proxyCtl();
  if (parent && /routes[\\/]adminRoutes\.js$/.test(parent.filename) && /middleware[\\/]authMiddleware/.test(request)) return { protect: pass, authorize: () => pass };
  return origLoad.call(this, request, parent, ...rest);
};

const ctl = require('../controllers/adminAuditController');
const call = async (query) => {
  let body; const res = { json: (b) => { body = b; }, status() { return res; } };
  await ctl.listAuditLogs({ query }, res, (e) => { throw e; });
  return body;
};

(async () => {
  // Pagination + serialisation (userAgent is never exposed).
  const p1 = await call({ page: '1', limit: '25' });
  assert.strictEqual(p1.success, true);
  assert.strictEqual(p1.data.length, 25);
  assert.strictEqual(p1.total, 57);
  assert.strictEqual(p1.pages, 3);
  assert.ok(!('userAgent' in p1.data[0]), 'userAgent must not be returned');
  assert.strictEqual(p1.data[0].action, 'admin.permissions.update');
  const p3 = await call({ page: '3', limit: '25' });
  assert.strictEqual(p3.data.length, 7);

  // Limit is capped; junk paging falls back safely.
  await call({ limit: '5000' });
  assert.strictEqual(lastFind.limit, 100);
  await call({ page: 'abc', limit: 'x' });
  assert.strictEqual(lastFind.skip, 0);
  assert.strictEqual(lastFind.limit, 25);

  // Filters: action family prefix, exact action, actor id, text, dates, regex safety.
  await call({ action: 'restaurant.' });
  assert.strictEqual(lastFind.filter.action.$regex, '^restaurant\\.');
  await call({ action: 'admin.permissions.update', targetType: 'admin' });
  assert.strictEqual(lastFind.filter.action, 'admin.permissions.update');
  assert.strictEqual(lastFind.filter.targetType, 'admin');
  await call({ actor: 'not-an-id' });
  assert.ok(!lastFind.filter.actor, 'invalid actor id must be ignored');
  await call({ actor: 'a'.repeat(24) });
  assert.strictEqual(lastFind.filter.actor, 'a'.repeat(24));
  await call({ q: '(.*)' });
  assert.ok(lastFind.filter.$or[0].actorName.$regex.includes('\\('), 'free text must be regex-escaped');
  await call({ from: '2026-10-01', to: '2026-10-02' });
  assert.strictEqual(lastFind.filter.createdAt.$gte.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.strictEqual(lastFind.filter.createdAt.$lte.toISOString(), '2026-10-02T23:59:59.999Z');
  await call({ from: 'garbage' });
  assert.ok(!lastFind.filter.createdAt, 'unparseable dates are ignored');

  // Route: registered, GET, gated by full-admin middleware.
  require('../routes/adminRoutes');
  const r = routes.find((x) => x.method === 'get' && x.path === '/audit-logs');
  assert.ok(r, 'GET /audit-logs must be registered');
  const names = r.handlers.map((h) => h.name || h.handlerName);
  assert.ok(names.includes('requireFullAdmin'), 'audit-logs must require a full administrator');
  const restricted = { user: { role: 'admin', permissions: ['finance.manage'] } };
  let status = 0; let nextCalled = false;
  const fullGate = r.handlers.find((h) => h.name === 'requireFullAdmin');
  fullGate(restricted, { status(c) { status = c; return { json() {} }; } }, () => { nextCalled = true; });
  assert.strictEqual(status, 403); assert.strictEqual(nextCalled, false);

  console.log('admin-audit-logs: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });

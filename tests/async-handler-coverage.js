// Regression test: a route handler must never be a raw async function.
// Before: notificationController, platformController and settlementController exported plain async functions.
// Express 4 does not catch a rejected promise, so PATCH /api/notifications/abc/read (a bad id makes Mongoose throw)
// became an unhandledRejection, and server.js answers that with server.close() + process.exit(1):
// any logged-in customer could shut the API down. Now every handler is wrapped (errors go to next(err)).
// Runs with no database (stubs). Usage: npm run test:async-handlers
const Module = require('module');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const ROUTES = path.join(ROOT, 'routes');

const isRawAsync = (h) => Object.prototype.toString.call(h) === '[object AsyncFunction]';
const anything = new Proxy(function () {}, { get: (t, p) => (p === 'then' ? undefined : anything), apply: () => anything, construct: () => anything });

// Loads one routes file with a recording express stub. `models` lets a test replace specific model modules.
const loadRoutes = (file, models = {}) => {
  const recorded = [];
  const mkRouter = () => {
    const r = {};
    for (const m of ['get', 'post', 'put', 'patch', 'delete', 'all', 'use']) {
      r[m] = (...args) => {
        const first = args[0];
        const hasPath = typeof first === 'string' || first instanceof RegExp || Array.isArray(first);
        recorded.push({ method: m, path: hasPath ? String(first) : '(use)', handlers: (hasPath ? args.slice(1) : args).flat() });
        return r;
      };
    }
    r.route = (p) => { const x = {}; for (const m of ['get', 'post', 'put', 'patch', 'delete', 'all']) x[m] = (...hs) => { recorded.push({ method: m, path: String(p), handlers: hs.flat() }); return x; }; return x; };
    return r;
  };
  const express = () => mkRouter();
  express.Router = mkRouter;
  express.json = express.urlencoded = express.static = express.raw = () => () => {};
  const limiter = (opts) => Object.assign((req, res, next) => next && next(), { opts });
  const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const builtins = new Set(Module.builtinModules);
  const origLoad = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (request === 'express') return express;
    if (request === 'express-rate-limit') return limiter;
    if (request === 'express-async-handler') return asyncHandler;
    if (path.isAbsolute(request) || builtins.has(request) || request.startsWith('node:')) return origLoad.call(this, request, parent, ...rest);
    if (request.startsWith('.')) {
      const resolved = path.resolve(path.dirname(parent.filename), request);
      for (const [name, stub] of Object.entries(models)) if (resolved.endsWith(path.join('models', name))) return stub;
      if (resolved.includes(path.sep + 'models' + path.sep)) return anything;
      return origLoad.call(this, request, parent, ...rest);
    }
    return anything;
  };
  try {
    for (const k of Object.keys(require.cache)) if (k.startsWith(ROOT) && !k.includes(path.sep + 'tests' + path.sep)) delete require.cache[k];
    require(path.join(ROUTES, file));
  } finally { Module._load = origLoad; }
  return recorded;
};

// protect / optionalAuth are async but keep every await inside try/catch (scenario E proves it).
const SELF_CATCHING = new Set(['protect', 'optionalAuth']);

const rejecting = () => Promise.reject(Object.assign(new Error('Cast to ObjectId failed'), { name: 'CastError' }));
const chain = () => { const c = { sort: () => c, limit: () => c, lean: () => c, select: () => c, populate: () => c, then: (res, rej) => rejecting().then(res, rej) }; return c; };
const lastHandler = (recorded, method, p) => {
  const r = recorded.find((x) => x.method === method && x.path === p);
  assert.ok(r, `route ${method.toUpperCase()} ${p} not found`);
  return r.handlers[r.handlers.length - 1];
};
const callHandler = async (h, req) => {
  const out = { nextErr: null, sent: false };
  let unhandled = null;
  const onUnhandled = (e) => { unhandled = e; };
  process.on('unhandledRejection', onUnhandled);
  const res = { status() { out.sent = true; return res; }, json() { out.sent = true; return res; }, set() { return res; } };
  try {
    // a raw async handler returns a rejected promise that Express 4 never sees: swallow it here and count it as unhandled
    const ret = h({ params: {}, body: {}, query: {}, ...req }, res, (e) => { out.nextErr = e || new Error('next()'); });
    if (ret && typeof ret.then === 'function') ret.catch((e) => { out.leaked = e; });
    await new Promise((r) => setTimeout(r, 30));
  } finally { process.removeListener('unhandledRejection', onUnhandled); }
  out.unhandled = unhandled;
  return out;
};

(async () => {
  let pass = 0;
  const t = async (name, fn) => { await fn(); pass++; console.log('PASS', name); };

  await t('A: no route handler in any routes/*.js is a raw async function', async () => {
    const bad = [];
    const files = fs.readdirSync(ROUTES).filter((f) => f.endsWith('.js'));
    for (const f of files) {
      const rec = loadRoutes(f);
      assert.ok(rec.length > 0, `${f}: no routes recorded (loader problem)`);
      for (const r of rec) r.handlers.forEach((h) => { if (isRawAsync(h) && !SELF_CATCHING.has(h.name)) bad.push(`${f}: ${r.method.toUpperCase()} ${r.path}`); });
    }
    assert.deepStrictEqual(bad, [], 'raw async handlers (an error in them crashes the server):\n  ' + bad.join('\n  '));
  });

  await t('B: notification handlers send DB errors to next(err) and never reject on their own', async () => {
    const Notification = { find: () => chain(), findOneAndUpdate: () => rejecting(), updateMany: () => rejecting() };
    const rec = loadRoutes('notificationRoutes.js', { Notification });
    const cases = [['get', '/'], ['patch', '/:id/read'], ['post', '/admin-new-orders/acknowledge']];
    for (const [m, p] of cases) {
      const h = lastHandler(rec, m, p);
      const out = await callHandler(h, { params: { id: 'abc' }, user: { _id: 'u1', role: 'admin' } });
      assert.ok(out.nextErr && out.nextErr.name === 'CastError', `${m} ${p}: error was not passed to next()`);
      assert.ok(!out.leaked && !out.unhandled, `${m} ${p}: promise rejected on its own (would crash the server)`);
      assert.strictEqual(out.sent, false, `${m} ${p}: must not answer before the error handler`);
    }
  });

  await t('C: platform admin handlers send DB errors to next(err)', async () => {
    const Zone = { find: () => chain(), findByIdAndUpdate: () => rejecting(), findByIdAndDelete: () => rejecting(), create: () => rejecting() };
    const rec = loadRoutes('platformRoutes.js', { DeliveryZone: Zone });
    for (const [m, p] of [['get', '/zones'], ['put', '/zones/:id'], ['delete', '/zones/:id'], ['post', '/zones']]) {
      const out = await callHandler(lastHandler(rec, m, p), { params: { id: 'abc' }, body: { name: 'x' }, user: { _id: 'a1', role: 'admin' } });
      assert.ok(out.nextErr && out.nextErr.name === 'CastError', `${m} ${p}: error was not passed to next()`);
      assert.ok(!out.leaked && !out.unhandled, `${m} ${p}: promise rejected on its own`);
    }
  });

  await t('D: a wrapped handler still answers normally on success', async () => {
    const Notification = { find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [{ _id: 'n1' }] }) }) }) };
    const rec = loadRoutes('notificationRoutes.js', { Notification });
    const out = await callHandler(lastHandler(rec, 'get', '/'), { user: { _id: 'u1', role: 'user' } });
    assert.strictEqual(out.nextErr, null);
    assert.strictEqual(out.sent, true);
  });

  await t('E: protect / optionalAuth never reject when the database fails', async () => {
    const origLoad = Module._load;
    const User = { findById: () => ({ select: () => ({ lean: () => rejecting() }) }) };
    const jwt = { verify: () => ({ id: '1', tv: 0 }) };
    Module._load = function (request, parent, ...rest) {
      if (request === 'jsonwebtoken') return jwt;
      if (request.startsWith('.') && path.resolve(path.dirname(parent.filename), request).endsWith(path.join('models', 'User'))) return User;
      return origLoad.call(this, request, parent, ...rest);
    };
    let mw;
    try {
      delete require.cache[path.join(ROOT, 'middleware/authMiddleware.js')];
      mw = require(path.join(ROOT, 'middleware/authMiddleware.js'));
    } finally { Module._load = origLoad; }
    const req = () => ({ headers: { authorization: 'Bearer sometoken' } });
    const a = await callHandler(mw.protect, req());
    assert.ok(!a.leaked && !a.unhandled, 'protect rejected on its own');
    assert.strictEqual(a.sent, true, 'protect must answer 401 when the database fails');
    const b = await callHandler(mw.optionalAuth, req());
    assert.ok(!b.leaked && !b.unhandled, 'optionalAuth rejected on its own');
  });

  console.log(`\n${pass} scenarios passed`);
  process.exit(0);
})().catch((e) => { console.log('FAIL', e && e.message ? e.message : e); process.exit(1); });

'use strict';
// Static route inventory. Loads every file in routes/ with express, middleware and
// controllers replaced by recording stubs (no DB, no network, no secrets) and prints
// JSON: one entry per (method, path) with the ordered middleware chain and handler.
// Usage: node scripts/route-inventory.js > inventory.json
const Module = require('module');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const ROUTES_DIR = path.join(ROOT, 'routes');
const out = [];
let currentFile = null;

const tag = (label) => { const f = (req, res, next) => next && next(); f.__tag = label; return f; };
const universal = (label) => new Proxy(function () {}, {
  get: (_t, p) => (p === '__tag' ? label : p === Symbol.toPrimitive ? () => label : universal(`${label}.${String(p)}`)),
  apply: () => universal(`${label}()`),
});
const callerLine = () => {
  const m = (new Error().stack || '').split('\n').find(l => l.includes(`${path.sep}routes${path.sep}`) && !l.includes('route-inventory'));
  const r = m && m.match(/:(\d+):\d+\)?$/); return r ? Number(r[1]) : null;
};
const describe = (h) => (h && h.__tag) || (h && h.name) || 'anonymous';

function makeRouter() {
  const routerMw = []; // router.use(...) middleware applies to later routes
  const r = {};
  const add = (method) => (p, ...handlers) => {
    const flat = handlers.flat(Infinity);
    out.push({ file: currentFile, line: callerLine(), method: method.toUpperCase(), path: p, routerLevel: routerMw.map(describe), chain: flat.map(describe) });
    return r;
  };
  for (const m of ['get', 'post', 'put', 'patch', 'delete', 'all']) r[m] = add(m);
  r.use = (...a) => { if (typeof a[0] === 'string') a.shift(); routerMw.push(...a.flat(Infinity)); return r; };
  r.param = () => r;
  r.route = (p) => { const c = {}; for (const m of ['get', 'post', 'put', 'patch', 'delete']) c[m] = (...h) => { add(m)(p, ...h); return c; }; return c; };
  return r;
}

const middlewareStubs = {
  'middleware/authMiddleware.js': { protect: tag('protect'), optionalAuth: tag('optionalAuth'), authorize: (...r) => tag(`authorize(${r.join('|')})`) },
  'middleware/roleMiddleware.js': (...r) => tag(`role(${r.join('|')})`),
  'middleware/permissionMiddleware.js': { requirePermission: (...p) => tag(`requirePermission(${p.join('|')})`), requirePermissionForAdmin: (...p) => tag(`requirePermissionForAdmin(${p.join('|')})`), requireFullAdmin: tag('requireFullAdmin') },
  'middleware/validateMiddleware.js': tag('validate'),
  'middleware/uploadMiddleware.js': { single: () => tag('upload.single'), array: () => tag('upload.array'), fields: () => tag('upload.fields') },
  'middleware/customerMediaUpload.js': { single: () => tag('customerMediaUpload'), array: () => tag('customerMediaUpload') },
  'utils/riderUpload.js': { upload: { single: () => tag('riderUpload'), array: () => tag('riderUpload'), fields: () => tag('riderUpload') } },
};
const expressStub = Object.assign(() => ({}), { Router: makeRouter, json: () => tag('json'), raw: () => tag('raw') });
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'express') return expressStub;
  if (request === 'express-async-handler') return (fn) => fn;
  if (request === 'express-rate-limit') return () => tag('rateLimit');
  if (request === 'multer') { const m = () => ({ single: () => tag('multer'), array: () => tag('multer'), fields: () => tag('multer') }); m.memoryStorage = () => ({}); m.diskStorage = () => ({}); m.MulterError = Error; return m; }
  const resolved = parent && request.startsWith('.') ? path.relative(ROOT, path.resolve(path.dirname(parent.filename), request)).replace(/\\/g, '/') : request;
  for (const [k, v] of Object.entries(middlewareStubs)) if (resolved === k.replace(/\.js$/, '') || resolved === k) return v;
  if (request.startsWith('.') && /controllers\//.test(resolved)) {
    return new Proxy({}, { get: (_t, p) => { const f = (req, res) => res && res.json && res.json({}); f.__tag = `${path.basename(resolved)}#${String(p)}`; return f; } });
  }
  if (request.startsWith('.') && /(models|services|utils)\//.test(resolved)) return universal(resolved);
  if (['express-validator', 'jsonwebtoken', 'bcryptjs', 'mongoose'].includes(request)) return universal(request);
  return origLoad.apply(this, arguments);
};
for (const f of fs.readdirSync(ROUTES_DIR).filter(f => f.endsWith('.js')).sort()) {
  currentFile = `routes/${f}`;
  try { require(path.join(ROUTES_DIR, f)); } catch (e) { out.push({ file: currentFile, error: String(e.message) }); }
}
process.stdout.write(JSON.stringify(out, null, 1));

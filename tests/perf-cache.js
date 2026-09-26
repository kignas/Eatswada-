#!/usr/bin/env node
'use strict';
// Regression test for the in-memory caches on GET /api/categories and
// GET /api/home-banners (utils/memoryCache.js). Runs with no database and no
// npm packages (in-memory fakes, same pattern as tests/payment-fixes.js).
// Usage: node tests/perf-cache.js

const Module = require('module');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const RealDate = Date;
let passed = 0;

async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

// ── Controllable clock: `new Date()` returns fixedNow; Date.now() stays real
// (the cache TTL uses Date.now()). Dates made with arguments are unaffected.
let fixedNow = RealDate.now();
class ClockDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(fixedNow); else super(...args); }
}
global.Date = ClockDate;
const at = (ms) => new ClockDate(ms);

// ── Tiny MongoDB-semantics matcher for the filters these controllers use ──
const isDate = (v) => v instanceof RealDate;
function matchValue(value, cond) {
  if (cond === null) return value === null || value === undefined;        // null matches null OR missing
  if (cond && typeof cond === 'object' && !isDate(cond)) {
    if ('$lte' in cond) return isDate(value) && isDate(cond.$lte) && value.getTime() <= cond.$lte.getTime();
    if ('$gte' in cond) return isDate(value) && isDate(cond.$gte) && value.getTime() >= cond.$gte.getTime();
    throw new Error('unsupported operator in fake');
  }
  return value === cond;
}
function matches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$and') return cond.every((f) => matches(doc, f));
    if (key === '$or') return cond.some((f) => matches(doc, f));
    return matchValue(doc[key], cond);
  });
}
const cloneDoc = (doc) => {
  const out = {};
  for (const [k, v] of Object.entries(doc)) out[k] = isDate(v) ? new Date(v.getTime()) : (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);
  return out;
};
function sortDocs(docs, spec) {
  const keys = Object.entries(spec || {});
  return docs.slice().sort((a, b) => {
    for (const [k, dir] of keys) {
      const av = a[k] instanceof RealDate ? a[k].getTime() : a[k];
      const bv = b[k] instanceof RealDate ? b[k].getTime() : b[k];
      if (av < bv) return -dir;
      if (av > bv) return dir;
    }
    return 0;
  });
}
function project(doc, fields) {
  if (!fields) return cloneDoc(doc);
  const wanted = new Set(['_id', ...fields.split(/\s+/).filter(Boolean)]);
  const out = {};
  for (const [k, v] of Object.entries(cloneDoc(doc))) if (wanted.has(k)) out[k] = v; // stored order, like MongoDB
  return out;
}

// ── Fake Category model (hydrated-doc style: toJSON, save) ────────────────
function makeCategoryModel() {
  const store = [];
  let seq = 0;
  const stats = { reads: 0, failNextRead: false };
  const wrap = (raw) => ({
    ...raw,
    toJSON() { const { toJSON, save, ...rest } = this; return rest; },
    async save() { const i = store.findIndex((d) => d._id === this._id); store[i] = { ...store[i], isActive: this.isActive, order: this.order, name: this.name }; return this; },
  });
  const query = (filter, sortSpec, one) => ({
    sort(spec) { return query(filter, spec, one); },
    then(resolve, reject) {
      stats.reads += 1;
      if (stats.failNextRead) { stats.failNextRead = false; return Promise.reject(new Error('db down')).then(resolve, reject); }
      const rows = sortDocs(store.filter((d) => matches(d, filter)), sortSpec).map((d) => wrap(cloneDoc(d)));
      return Promise.resolve(one ? rows[0] || null : rows).then(resolve, reject);
    },
  });
  return {
    stats, store,
    find(filter) { return query(filter || {}, null, false); },
    findOne(filter) { return query(filter || {}, null, true); },
    async findById(id) { const d = store.find((x) => x._id === id); return d ? wrap(cloneDoc(d)) : null; },
    async create(payload) { const d = { _id: `c${++seq}`, image: 'default.jpg', order: 0, isActive: true, ...payload }; store.push(d); return wrap(cloneDoc(d)); },
    async findByIdAndUpdate(id, update) { const i = store.findIndex((x) => x._id === id); if (i < 0) return null; store[i] = { ...store[i], ...update }; return wrap(cloneDoc(store[i])); },
    async findByIdAndDelete(id) { const i = store.findIndex((x) => x._id === id); if (i < 0) return null; const [d] = store.splice(i, 1); return wrap(d); },
    async bulkWrite(ops) { for (const op of ops) { const d = store.find((x) => x._id === op.updateOne.filter._id); if (d) Object.assign(d, op.updateOne.update.$set); } },
  };
}

// ── Fake HomeBanner model (lean docs) ─────────────────────────────────────
function makeBannerModel() {
  const store = [];
  let seq = 0;
  const stats = { reads: 0 };
  const query = (filter) => {
    let fields = null; let sortSpec = null;
    const q = {
      select(f) { fields = f; return q; },
      sort(s) { sortSpec = s; return q; },
      lean() { return q; },
      then(resolve, reject) {
        stats.reads += 1;
        const rows = sortDocs(store.filter((d) => matches(d, filter)), sortSpec).map((d) => project(d, fields));
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return q;
  };
  const hydrate = (raw) => ({
    ...raw,
    toObject() { const { toObject, save, deleteOne, ...rest } = this; return rest; },
    async save() { const i = store.findIndex((d) => d._id === this._id); const { toObject, save, deleteOne, ...rest } = this; store[i] = cloneDoc(rest); return this; },
    async deleteOne() { const i = store.findIndex((d) => d._id === this._id); store.splice(i, 1); },
  });
  return {
    stats, store,
    add(doc) { const d = { _id: `b${++seq}`, ...doc }; store.push(d); return d; },
    find(filter) { return query(filter || {}); },
    async findById(id) { const d = store.find((x) => x._id === id); return d ? hydrate(cloneDoc(d)) : null; },
    // Same defaults models/HomeBanner.js applies on create.
    async create(payload) { const d = this.add({ placement: 'home', active: true, priority: 0, startAt: null, endAt: null, createdAt: new ClockDate(), ...payload }); return hydrate(cloneDoc(d)); },
    async bulkWrite(ops) { for (const op of ops) { const d = store.find((x) => x._id === op.updateOne.filter._id); if (d) Object.assign(d, op.updateOne.update.$set); } },
  };
}

// ── Module stubbing ───────────────────────────────────────────────────────
const CATEGORY_MODEL = path.join(ROOT, 'models/Category.js');
const BANNER_MODEL = path.join(ROOT, 'models/HomeBanner.js');
const AUDIT = path.join(ROOT, 'services/auditService.js');
const stubs = {
  'express-async-handler': (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
  mongoose: { isValidObjectId: (v) => typeof v === 'string' && v.length > 0 },
  [AUDIT]: { logAdminAction: async () => {} },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return request;
  return origResolve.call(this, request, parent, ...rest);
};
function install(file, exportsValue) { require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsValue }; }
for (const [k, v] of Object.entries(stubs)) install(k, v);

function loadController(rel, env) {
  const file = path.join(ROOT, rel);
  delete require.cache[file];
  delete require.cache[path.join(ROOT, 'utils/memoryCache.js')];
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return require(file); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

function call(handler, req = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body: JSON.parse(JSON.stringify(body)) }); return this; },
    };
    handler({ query: {}, params: {}, body: {}, user: { _id: 'admin1' }, ...req }, res, (err) => resolve({ error: err }));
  });
}

(async () => {
  // ── 1. memoryCache unit behaviour ───────────────────────────────────────
  const { createMemoryCache, readTtlMs } = require(path.join(ROOT, 'utils/memoryCache.js'));

  await check('memoryCache: hit within TTL, single DB call', async () => {
    const c = createMemoryCache({ ttlMs: 10000 }); let n = 0;
    assert.strictEqual(await c.get('k', async () => ++n), 1);
    assert.strictEqual(await c.get('k', async () => ++n), 1);
    assert.strictEqual(n, 1);
  });

  await check('memoryCache: expires after TTL', async () => {
    const c = createMemoryCache({ ttlMs: 20 }); let n = 0;
    await c.get('k', async () => ++n);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(await c.get('k', async () => ++n), 2);
  });

  await check('memoryCache: concurrent callers share one load (single-flight)', async () => {
    const c = createMemoryCache({ ttlMs: 10000 }); let n = 0;
    const results = await Promise.all(Array.from({ length: 25 }, () => c.get('k', async () => { await new Promise((r) => setTimeout(r, 10)); return ++n; })));
    assert.strictEqual(n, 1);
    assert.ok(results.every((v) => v === 1));
  });

  await check('memoryCache: invalidate during a load -> result not stored', async () => {
    const c = createMemoryCache({ ttlMs: 10000 }); let n = 0;
    const p = c.get('k', async () => { await new Promise((r) => setTimeout(r, 10)); return ++n; });
    c.invalidate();
    assert.strictEqual(await p, 1);                        // waiting caller still answered
    assert.strictEqual(await c.get('k', async () => ++n), 2); // but next call reloads
  });

  await check('memoryCache: failures are not cached', async () => {
    const c = createMemoryCache({ ttlMs: 10000 }); let n = 0;
    await assert.rejects(c.get('k', async () => { n++; throw new Error('boom'); }));
    assert.strictEqual(await c.get('k', async () => ++n), 2);
  });

  await check('memoryCache: ttl 0 disables caching entirely', async () => {
    const c = createMemoryCache({ ttlMs: 0 }); let n = 0;
    await c.get('k', async () => ++n); await c.get('k', async () => ++n);
    assert.strictEqual(n, 2); assert.strictEqual(c.enabled, false);
  });

  await check('memoryCache: readTtlMs parses env safely', async () => {
    process.env.__T = ''; assert.strictEqual(readTtlMs('__T', 5), 5);
    process.env.__T = 'abc'; assert.strictEqual(readTtlMs('__T', 5), 5);
    process.env.__T = '-1'; assert.strictEqual(readTtlMs('__T', 5), 5);
    process.env.__T = '0'; assert.strictEqual(readTtlMs('__T', 5), 0);
    process.env.__T = '1500'; assert.strictEqual(readTtlMs('__T', 5), 1500);
    delete process.env.__T; assert.strictEqual(readTtlMs('__T', 5), 5);
  });

  // ── 2. Categories ───────────────────────────────────────────────────────
  const Category = makeCategoryModel();
  install(CATEGORY_MODEL, Category);
  for (const [name, order, isActive] of [['Pizza', 2, true], ['Biryani', 1, true], ['Rolls', 1, true], ['Hidden', 0, false]]) await Category.create({ name, order, isActive });

  const catCached = loadController('controllers/categoryController.js', { CATEGORY_CACHE_TTL_MS: undefined });
  const catUncached = loadController('controllers/categoryController.js', { CATEGORY_CACHE_TTL_MS: '0' });

  await check('categories: cached response identical to uncached response', async () => {
    const a = await call(catCached.getCategories); const b = await call(catUncached.getCategories);
    assert.deepStrictEqual(a, b);
    assert.deepStrictEqual(a.body.data.map((c) => c.name), ['Biryani', 'Rolls', 'Pizza']);
  });

  await check('categories: 30 concurrent + 10 repeat GETs hit MongoDB once', async () => {
    const fresh = loadController('controllers/categoryController.js', { CATEGORY_CACHE_TTL_MS: undefined });
    const before = Category.stats.reads;
    await Promise.all(Array.from({ length: 30 }, () => call(fresh.getCategories)));
    for (let i = 0; i < 10; i++) await call(fresh.getCategories);
    assert.strictEqual(Category.stats.reads - before, 1);
  });

  const expectFreshAfter = async (label, action, verify) => {
    await call(catCached.getCategories); // warm
    await action();
    const before = Category.stats.reads;
    const res = await call(catCached.getCategories);
    assert.strictEqual(Category.stats.reads - before, 1, `${label} must invalidate the cache`);
    assert.deepStrictEqual(res, await call(catUncached.getCategories));
    if (verify) verify(res.body.data);
  };

  await check('categories: create invalidates', () => expectFreshAfter('create', () => call(catCached.createCategory, { body: { name: 'Momos', order: 0 } }), (d) => assert.strictEqual(d[0].name, 'Momos')));
  await check('categories: create without order (appends) invalidates', () => expectFreshAfter('create-append', () => call(catCached.createCategory, { body: { name: 'Thali' } }), (d) => assert.strictEqual(d[d.length - 1].name, 'Thali')));
  await check('categories: update invalidates', () => expectFreshAfter('update', () => call(catCached.updateCategory, { params: { id: 'c1' }, body: { name: 'Pizzas' } }), (d) => assert.ok(d.some((c) => c.name === 'Pizzas'))));
  await check('categories: toggle invalidates', () => expectFreshAfter('toggle', () => call(catCached.toggleCategoryStatus, { params: { id: 'c1' } }), (d) => assert.ok(!d.some((c) => c.name === 'Pizzas'))));
  await check('categories: delete invalidates', () => expectFreshAfter('delete', () => call(catCached.deleteCategory, { params: { id: 'c2' } }), (d) => assert.ok(!d.some((c) => c.name === 'Biryani'))));
  await check('categories: reorder invalidates', () => expectFreshAfter('reorder', () => call(catCached.reorderCategories, { body: { items: [{ id: 'c3', order: 99 }] } }), (d) => assert.strictEqual(d[d.length - 1].name, 'Rolls')));

  await check('categories: admin /all is never cached', async () => {
    const before = Category.stats.reads;
    await call(catCached.getAllCategories); await call(catCached.getAllCategories);
    assert.strictEqual(Category.stats.reads - before, 2);
  });

  await check('categories: DB error reaches the error handler and is not cached', async () => {
    const fresh = loadController('controllers/categoryController.js', { CATEGORY_CACHE_TTL_MS: undefined });
    Category.stats.failNextRead = true;
    const failed = await call(fresh.getCategories);
    assert.ok(failed.error && /db down/.test(failed.error.message));
    const ok = await call(fresh.getCategories);
    assert.strictEqual(ok.status, 200);
  });

  await check('categories: CATEGORY_CACHE_TTL_MS=0 reads MongoDB every time', async () => {
    const before = Category.stats.reads;
    await call(catUncached.getCategories); await call(catUncached.getCategories);
    assert.strictEqual(Category.stats.reads - before, 2);
  });

  // ── 3. Home banners ─────────────────────────────────────────────────────
  const Banner = makeBannerModel();
  install(BANNER_MODEL, Banner);
  const T = RealDate.UTC(2026, 8, 26, 6, 0, 0);
  const base = { title: 't', subtitle: 's', offerText: '', badgeText: '', ctaText: 'Order now', ctaUrl: '/x', image: 'https://i/x.jpg', mobileImage: '', background: '#0B6B46', textColor: 'light', animation: 'fade', headerTheme: 'anime', searchPlaceholder: '', active: true, createdBy: 'a', updatedBy: 'a' };
  const mk = (extra) => Banner.add({ ...base, placement: 'home', priority: 0, createdAt: at(T - 1000), updatedAt: at(T), ...extra });
  mk({ title: 'no-schedule-keys' });
  mk({ title: 'null-schedule', startAt: null, endAt: null, priority: 5 });
  mk({ title: 'running', startAt: at(T - 60000), endAt: at(T + 60000), priority: 5, createdAt: at(T - 500) });
  mk({ title: 'future', startAt: at(T + 60000), endAt: null, priority: 9 });
  mk({ title: 'ended', startAt: null, endAt: at(T - 1), priority: 9 });
  mk({ title: 'starts-exactly-T', startAt: at(T), priority: 1 });
  mk({ title: 'ends-exactly-T', endAt: at(T), priority: 1 });
  mk({ title: 'string-start', startAt: '2020-01-01T00:00:00Z', priority: 3 });
  mk({ title: 'string-end', endAt: '2999-01-01T00:00:00Z', priority: 3 });
  mk({ title: 'inactive', active: false, priority: 50 });
  mk({ title: 'under99-banner', placement: 'under99', priority: 2 });

  const banCached = loadController('controllers/homeBannerController.js', { HOME_BANNER_CACHE_TTL_MS: undefined });
  const banUncached = loadController('controllers/homeBannerController.js', { HOME_BANNER_CACHE_TTL_MS: '0' });

  await check('banners: cached == original query at every schedule boundary', async () => {
    for (const offset of [-120000, -60001, -60000, -1, 0, 1, 59999, 60000, 60001, 120000]) {
      fixedNow = T + offset;
      for (const placement of ['home', 'under99', undefined]) {
        const req = { query: placement ? { placement } : {} };
        const a = await call(banCached.getActiveBanners, req);
        const b = await call(banUncached.getActiveBanners, req);
        assert.deepStrictEqual(a, b, `mismatch at T${offset >= 0 ? '+' : ''}${offset}ms placement=${placement}`);
      }
    }
    fixedNow = T;
    const titles = (await call(banCached.getActiveBanners)).body.data.map((b) => b.title);
    // priority desc, then createdAt desc ('running' is newer than 'null-schedule')
    assert.deepStrictEqual(titles, ['running', 'null-schedule', 'starts-exactly-T', 'ends-exactly-T', 'no-schedule-keys']);
  });

  await check('banners: scheduled banner turns on/off with a warm cache (no write needed)', async () => {
    fixedNow = T + 59999;
    let titles = (await call(banCached.getActiveBanners)).body.data.map((b) => b.title);
    assert.ok(!titles.includes('future'));
    fixedNow = T + 60000; // both boundaries are inclusive ($lte / $gte)
    titles = (await call(banCached.getActiveBanners)).body.data.map((b) => b.title);
    assert.ok(titles.includes('future') && titles.includes('running'));
    fixedNow = T + 60001;
    titles = (await call(banCached.getActiveBanners)).body.data.map((b) => b.title);
    assert.ok(titles.includes('future') && !titles.includes('running'));
    fixedNow = T;
  });

  await check('banners: response has no startAt/endAt and exact original key order', async () => {
    const a = await call(banCached.getActiveBanners); const b = await call(banUncached.getActiveBanners);
    for (const row of a.body.data) { assert.ok(!('startAt' in row) && !('endAt' in row)); }
    assert.deepStrictEqual(a.body.data.map(Object.keys), b.body.data.map(Object.keys));
  });

  await check('banners: repeat + concurrent GETs hit MongoDB once per placement', async () => {
    const fresh = loadController('controllers/homeBannerController.js', { HOME_BANNER_CACHE_TTL_MS: undefined });
    const before = Banner.stats.reads;
    await Promise.all([
      ...Array.from({ length: 20 }, () => call(fresh.getActiveBanners, { query: { placement: 'home' } })),
      ...Array.from({ length: 10 }, () => call(fresh.getActiveBanners, { query: { placement: 'under99' } })),
    ]);
    assert.strictEqual(Banner.stats.reads - before, 2);
  });

  await check('banners: invalid placement still 400', async () => {
    const r = await call(banCached.getActiveBanners, { query: { placement: 'nope' } });
    assert.strictEqual(r.status, 400);
  });

  const expectBannerFreshAfter = async (label, action) => {
    await call(banCached.getActiveBanners); // warm
    const r = await action();
    assert.ok(!r.error && r.status < 400, `${label} failed: ${JSON.stringify(r)}`);
    const before = Banner.stats.reads;
    const res = await call(banCached.getActiveBanners);
    assert.strictEqual(Banner.stats.reads - before, 1, `${label} must invalidate the cache`);
    assert.deepStrictEqual(res, await call(banUncached.getActiveBanners));
  };
  await check('banners: create invalidates', () => expectBannerFreshAfter('create', () => call(banCached.createBanner, { body: { title: 'new', image: 'https://i/n.jpg', priority: 100 } })));
  await check('banners: update invalidates', () => expectBannerFreshAfter('update', () => call(banCached.updateBanner, { params: { id: 'b1' }, body: { title: 'renamed' } })));
  await check('banners: toggle invalidates', () => expectBannerFreshAfter('toggle', () => call(banCached.toggleBanner, { params: { id: 'b2' } })));
  await check('banners: delete invalidates', () => expectBannerFreshAfter('delete', () => call(banCached.deleteBanner, { params: { id: 'b3' } })));
  await check('banners: reorder invalidates', () => expectBannerFreshAfter('reorder', () => call(banCached.reorderBanners, { body: { items: [{ id: 'b1', priority: 999 }] } })));

  await check('banners: admin /all is never cached', async () => {
    const before = Banner.stats.reads;
    await call(banCached.getAllBanners); await call(banCached.getAllBanners);
    assert.strictEqual(Banner.stats.reads - before, 2);
  });

  global.Date = RealDate;
  console.log(`perf-cache: ${passed} passed, 0 failed`);
})().catch((err) => {
  global.Date = RealDate;
  console.error('FAIL', err && err.stack ? err.stack : err);
  console.log(`perf-cache: ${passed} passed, 1 failed`);
  process.exit(1);
});

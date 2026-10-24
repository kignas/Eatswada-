// Config / dependency hygiene guard. Runs with no database and no installed packages.
//   1. deprecated xss-clean is gone (package.json, lockfile, server.js) and replaced by the
//      in-repo middleware/sanitizeInput.js, which keeps the same protection (< is escaped in
//      every incoming string) without the dependency.
//   2. Node engine range matches what the lockfile needs; .nvmrc pins the dev version.
//   3. `npm test` chains every offline test:* suite (so a new suite cannot be forgotten); audit skips devDeps.
//   4. package.json and package-lock.json agree on the root dependency list.
// Usage: npm run test:config
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const server = read('server.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('PASS', name); };

// Not in the default `npm test`: live-server suites (need a deployed API) and the five
// financial suites that test:financial already runs as one group.
const NOT_IN_DEFAULT_TEST = new Set([
  'test:integration', 'test:deployment',
  'test:financial-cod', 'test:financial-payout', 'test:financial-settlement', 'test:financial-cross-cutting', 'test:financial-standalone',
]);

t('A: xss-clean is gone from package.json, package-lock.json and server.js', () => {
  assert.ok(!('xss-clean' in (pkg.dependencies || {})), 'package.json still lists xss-clean');
  assert.ok(!('xss-clean' in (pkg.devDependencies || {})));
  assert.ok(!('xss-clean' in (lock.packages[''].dependencies || {})), 'lockfile root still lists xss-clean');
  assert.ok(!lock.packages['node_modules/xss-clean'], 'lockfile still has the xss-clean package');
  assert.ok(!lock.packages['node_modules/xss-filters'], 'lockfile still has orphaned xss-filters');
  assert.ok(!/xss-clean|xssClean/.test(server), 'server.js still references xss-clean');
});

t('B: package.json and the lockfile root agree (deps, devDeps, engines) and every locked dep exists', () => {
  const root = lock.packages[''];
  assert.deepStrictEqual(root.dependencies, pkg.dependencies);
  assert.deepStrictEqual(root.devDependencies, pkg.devDependencies);
  assert.deepStrictEqual(root.engines, pkg.engines);
  for (const name of Object.keys(pkg.dependencies)) assert.ok(lock.packages['node_modules/' + name], name + ' missing from lockfile');
  // nothing is left depending on a package that was removed
  for (const [key, v] of Object.entries(lock.packages)) {
    for (const dep of Object.keys(v.dependencies || {})) {
      const nested = lock.packages[key + '/node_modules/' + dep];
      const top = lock.packages['node_modules/' + dep];
      assert.ok(nested || top, `${key || '(root)'} depends on ${dep} but it is not in the lockfile`);
    }
  }
});

t('C: engines.node is >=20.19.0 and .nvmrc pins Node 22', () => {
  assert.strictEqual(pkg.engines.node, '>=20.19.0');
  assert.ok(fs.existsSync(path.join(ROOT, '.nvmrc')), '.nvmrc is missing');
  assert.strictEqual(read('.nvmrc').trim(), '22');
});

t('D: `npm test` exists and chains every offline test:* suite', () => {
  const chain = pkg.scripts.test;
  assert.ok(chain, 'no "test" script');
  const called = [...chain.matchAll(/npm run ([\w:.-]+)/g)].map(m => m[1]);
  const expected = Object.keys(pkg.scripts).filter(k => k.startsWith('test:') && !NOT_IN_DEFAULT_TEST.has(k));
  for (const name of expected) assert.ok(called.includes(name), `npm test does not run ${name}`);
  for (const name of called) assert.ok(pkg.scripts[name], `npm test calls missing script ${name}`);
  assert.strictEqual(new Set(called).size, called.length, 'npm test lists a suite twice');
  assert.ok(!/;|\|\|/.test(chain), 'chain must stop at the first failing suite (use &&)');
});

t('E: every test:* script points at a file that exists', () => {
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    if (!name.startsWith('test:')) continue;
    for (const m of cmd.matchAll(/node (tests\/[\w./-]+\.js)/g)) assert.ok(fs.existsSync(path.join(ROOT, m[1])), `${name} -> ${m[1]} missing`);
  }
});

t('F: dependency audit ignores devDependencies (production risk only)', () => {
  assert.match(pkg.scripts['audit:deps'], /npm audit/);
  assert.match(pkg.scripts['audit:deps'], /--omit=dev/);
  assert.match(pkg.scripts['audit:deps'], /--audit-level=high/);
});

// ── sanitizeInput middleware ──────────────────────────────────────────────────────
let sanitizeInput;
try { sanitizeInput = require(path.join(ROOT, 'middleware/sanitizeInput.js')); }
catch (e) { console.error('FAIL: middleware/sanitizeInput.js is missing or broken:', e.message); process.exit(1); }
const run = (req) => { let called = 0; sanitizeInput(req, {}, () => { called++; }); assert.strictEqual(called, 1, 'next() must be called exactly once'); return req; };

t('G: < is escaped in every string of body and query: nested objects, arrays, deep values', () => {
  const req = run({
    body: { name: '<script>alert(1)</script>', address: { line: '<img src=x onerror=1>', tags: ['<b>', 'ok', ['<i>']] } },
    query: { q: '<svg/onload=1>', list: ['<a>', 'b'] },
  });
  assert.strictEqual(req.body.name, '&lt;script>alert(1)&lt;/script>');
  assert.strictEqual(req.body.address.line, '&lt;img src=x onerror=1>');
  assert.deepStrictEqual(req.body.address.tags, ['&lt;b>', 'ok', ['&lt;i>']]);
  assert.strictEqual(req.query.q, '&lt;svg/onload=1>');
  assert.deepStrictEqual(req.query.list, ['&lt;a>', 'b']);
  for (const v of [req.body.name, req.body.address.line, req.query.q]) assert.ok(!/</.test(v), 'no raw < may remain');
});

t('H: ordinary text is untouched: & quotes > unicode, whitespace, and non-strings (numbers, booleans, null, dates)', () => {
  const d = new Date('2026-01-01T00:00:00Z');
  const body = { n: 'Biryani & Co. "Special" it\'s 5 > 3 ₹250 नमस्ते', pad: '  keep spaces  ', num: 42, flag: false, nothing: null, when: d, empty: '' };
  const req = run({ body: JSON.parse(JSON.stringify(body)), query: {} });
  assert.strictEqual(req.body.n, body.n);
  assert.strictEqual(req.body.pad, '  keep spaces  ', 'must not trim');
  assert.strictEqual(req.body.num, 42);
  assert.strictEqual(req.body.flag, false);
  assert.strictEqual(req.body.nothing, null);
  assert.strictEqual(req.body.empty, '');
  const withDate = run({ body: { when: d }, query: {} });
  assert.strictEqual(withDate.body.when, d, 'non-plain objects are left alone');
});

t('I: running it twice does not double-escape (idempotent); & next to < stays a plain &', () => {
  const req = run({ body: { a: '<b>', mixed: 'Tom & Jerry <b>x</b> &lt; AT&T' }, query: {} });
  assert.strictEqual(req.body.mixed, 'Tom & Jerry &lt;b>x&lt;/b> &lt; AT&T');
  run(req);
  assert.strictEqual(req.body.a, '&lt;b>');
  assert.strictEqual(req.body.mixed, 'Tom & Jerry &lt;b>x&lt;/b> &lt; AT&T');
});

t('J: keys are not rewritten, the same body object is edited in place, missing/empty body and query are fine', () => {
  const body = { '<k>': 'v<' };
  const req = { body, query: {} };
  run(req);
  assert.strictEqual(req.body, body, 'same object (other middleware may hold a reference)');
  assert.deepStrictEqual(Object.keys(req.body), ['<k>']);
  assert.strictEqual(req.body['<k>'], 'v&lt;');
  run({});                                   // no body, no query
  run({ body: undefined, query: undefined });
  run({ body: Buffer.from('<raw>'), query: {} }); // raw webhook-style buffers are never rewritten
});

t('K: very deeply nested input cannot crash it (iterative, no stack overflow)', () => {
  let deep = { v: '<x>' };
  for (let i = 0; i < 20000; i++) deep = { n: deep };
  run({ body: deep, query: {} });
});

t('L: a cyclic structure cannot hang it', () => {
  const a = { s: '<x>' }; a.self = a;
  const req = run({ body: a, query: {} });
  assert.strictEqual(req.body.s, '&lt;x>');
});

t('M: wiring: applied after the body parsers and mongoSanitize, before hpp and any /api route; the raw webhook stays ahead of it', () => {
  assert.match(server, /require\('\.\/middleware\/sanitizeInput'\)/);
  const at = (re) => { const m = server.search(re); assert.ok(m >= 0, 'missing in server.js: ' + re); return m; };
  const webhook = at(/app\.post\('\/api\/payments\/webhook'/);
  const json = at(/app\.use\(express\.json\(/);
  const mongo = at(/app\.use\(mongoSanitize\(\)\)/);
  const san = at(/app\.use\(sanitizeInput\)/);
  const hpp = at(/app\.use\(hpp\(/);
  const firstApi = at(/app\.use\('\/api\//);
  assert.ok(webhook < san, 'webhook must keep the raw body (before the sanitizer)');
  assert.ok(json < san && mongo < san, 'sanitizer must run after parsing');
  assert.ok(san < hpp && san < firstApi, 'sanitizer must run before hpp and the routes');
});

console.log(`\n${pass} scenarios passed`);

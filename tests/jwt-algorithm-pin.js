// Regression test: JWTs are signed AND verified with HS256 only (algorithm pinned).
// Before: jwt.verify(token, secret) in middleware/authMiddleware.js (protect + optionalAuth) accepted whatever
// algorithm the token header named, and generateToken signed with the library default. Pinning removes the
// algorithm-confusion class entirely (even if the secret/library setup changes later).
// Runs with no database and no real jsonwebtoken (a small fake that models the algorithm header).
// Usage: npm run test:jwt-algorithm-pin
const Module = require('module');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const AUTH = path.join(ROOT, 'middleware/authMiddleware.js');
const GEN = path.join(ROOT, 'utils/generateToken.js');

// ── fake jsonwebtoken: token = <alg>.<b64 payload>.<hmac(secret, alg.payload)> ────────────
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const mac = (secret, data) => crypto.createHmac('sha256', String(secret)).update(data).digest('base64url');
const calls = { sign: [], verify: [] };
const fakeJwt = {
  sign(payload, secret, opts = {}) {
    calls.sign.push(opts);
    const alg = opts.algorithm || 'HS256'; // library default
    const head = `${alg}.${b64(payload)}`;
    return `${head}.${mac(secret, head)}`;
  },
  verify(token, secret, opts) {
    calls.verify.push(opts);
    const [alg, body, sig] = String(token).split('.');
    if (!alg || !body) throw new Error('jwt malformed');
    if (opts && opts.algorithms && !opts.algorithms.includes(alg)) throw new Error('invalid algorithm');
    if (alg !== 'none' && sig !== mac(secret, `${alg}.${body}`)) throw new Error('invalid signature');
    return JSON.parse(Buffer.from(body, 'base64url').toString());
  },
};
const forge = (alg, payload) => { const head = `${alg}.${b64(payload)}`; return `${head}.${alg === 'none' ? '' : mac(process.env.JWT_SECRET, head)}`; };

let findByIdCalls = 0;
let dbUser = { _id: 'U1', role: 'user', isActive: true, tokenVersion: 0 };
const User = { findById: () => { findByIdCalls++; const q = { select() { return q; }, lean: async () => dbUser }; return q; } };
const stubs = { jsonwebtoken: fakeJwt, [path.join(ROOT, 'models/User.js')]: User };
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (parent && (parent.filename === AUTH || parent.filename === GEN)) {
    const resolved = request.startsWith('.') ? path.resolve(path.dirname(parent.filename), request) + '.js' : request;
    if (stubs[resolved] || stubs[request]) return stubs[resolved] || stubs[request];
  }
  return origLoad.call(this, request, parent, ...rest);
};
process.env.JWT_SECRET = 'test-secret';
const { protect, optionalAuth } = require(AUTH);
const generateToken = require(GEN);
Module._load = origLoad;
const realLog = console.log; console.log = () => {};

const run = async (mw, token) => {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
  const out = { nexted: false };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
  await mw(req, res, () => { out.nexted = true; });
  return { req, out };
};
const reset = () => { calls.sign.length = 0; calls.verify.length = 0; findByIdCalls = 0; dbUser = { _id: 'U1', role: 'user', isActive: true, tokenVersion: 0 }; };

(async () => {
  let pass = 0;
  const t = async (name, fn) => { reset(); await fn(); pass++; realLog('PASS', name); };

  await t('A: a token from generateToken is signed with HS256 and keeps its expiry option', async () => {
    const token = generateToken('U1', 'user', 0);
    assert.strictEqual(calls.sign.length, 1);
    assert.strictEqual(calls.sign[0].algorithm, 'HS256');
    assert.ok(calls.sign[0].expiresIn, 'expiresIn lost');
    assert.strictEqual(token.split('.')[0], 'HS256');
  });

  await t('B: a normal login token still authenticates in protect and optionalAuth', async () => {
    const token = generateToken('U1', 'user', 0);
    const p = await run(protect, token);
    assert.ok(p.out.nexted && p.req.user && p.req.user._id === 'U1');
    const o = await run(optionalAuth, token);
    assert.ok(o.out.nexted && o.req.user && o.req.user._id === 'U1');
  });

  await t('C: both middlewares pass algorithms: [HS256] to jwt.verify', async () => {
    const token = generateToken('U1', 'user', 0);
    await run(protect, token);
    await run(optionalAuth, token);
    assert.strictEqual(calls.verify.length, 2);
    for (const opts of calls.verify) assert.deepStrictEqual(opts && opts.algorithms, ['HS256']);
  });

  await t('D: a token with another algorithm header (even with the right secret) is refused and never hits the DB', async () => {
    for (const alg of ['HS384', 'HS512', 'none', 'RS256']) {
      const token = forge(alg, { id: 'U1', role: 'user', tv: 0 });
      const p = await run(protect, token);
      assert.strictEqual(p.out.status, 401, `protect accepted ${alg}`);
      assert.ok(!p.out.nexted && !p.req.user);
      const o = await run(optionalAuth, token);
      assert.ok(o.out.nexted && !o.req.user, `optionalAuth treated ${alg} token as logged in`);
    }
    assert.strictEqual(findByIdCalls, 0, 'DB was queried for a wrong-algorithm token');
  });

  await t('E: existing checks still apply (no token, bad signature, revoked tokenVersion, inactive account)', async () => {
    assert.strictEqual((await run(protect, '')).out.status, 401);
    assert.strictEqual((await run(protect, 'HS256.' + b64({ id: 'U1' }) + '.bad')).out.status, 401);
    const stale = generateToken('U1', 'user', 0);
    dbUser = { ...dbUser, tokenVersion: 1 };
    assert.strictEqual((await run(protect, stale)).out.status, 401);
    assert.strictEqual((await run(optionalAuth, stale)).req.user, undefined);
    dbUser = { ...dbUser, tokenVersion: 0, isActive: false };
    assert.strictEqual((await run(protect, stale)).out.status, 401);
    assert.strictEqual((await run(optionalAuth, stale)).req.user, undefined);
  });

  await t('F: wiring — every active jwt.verify / jwt.sign call in the app pins the algorithm', async () => {
    const files = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'tests', '.git'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
    } };
    walk(ROOT);
    let verifyCalls = 0, signCalls = 0;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      for (const m of src.matchAll(/jwt\.verify\(([^;]*?)\);/g)) { verifyCalls++; assert.ok(/algorithms\s*:\s*\[/.test(m[1]) || /\bJWT_VERIFY_OPTIONS\b/.test(m[1]), `${path.relative(ROOT, f)}: jwt.verify without algorithms`); }
      for (const m of src.matchAll(/jwt\.sign\(([\s\S]*?)\n\s*\);/g)) { signCalls++; assert.ok(/algorithm\s*:/.test(m[1]), `${path.relative(ROOT, f)}: jwt.sign without algorithm`); }
    }
    assert.ok(verifyCalls >= 2 && signCalls >= 1, `scan found ${verifyCalls} verify / ${signCalls} sign calls`);
  });

  realLog(`\n${pass} scenarios passed`);
})().catch((e) => { realLog('FAIL', e && e.message ? e.message : e); process.exit(1); });

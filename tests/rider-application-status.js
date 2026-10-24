// Regression test: rider application status must need a secret token, and the duplicate 409 must not leak.
// Before: GET /rider-applications/:id/status was gated by id + phone only (Mongo ids are guessable, phones
// are not secret) and returned the admin's private reviewNote; the duplicate-application 409 returned the
// applicationId and status to anyone who typed someone else's phone number.
// Now: submit returns a random statusToken ONCE (only its sha256 is stored); status needs id + token;
// every non-match is the same plain 404; the 409 carries no applicationId/status.
// Runs with no database (in-memory fakes). Usage: npm run test:rider-application-status
const Module = require('module');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const CONTROLLER = path.join(ROOT, 'controllers/riderApplicationController.js');

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

// ---- fakes (the fake models select:false fields: they only come back when the query asks with +field) ----
const store = new Map();
let seq = 0;
const nextId = () => (++seq).toString(16).padStart(24, '0');
const HIDDEN = ['passwordHash', 'statusTokenHash'];
const view = (doc, sel) => {
  if (!doc) return null;
  const copy = { ...doc };
  const asked = String(sel || '').split(/\s+/);
  for (const f of HIDDEN) if (!asked.includes('+' + f)) delete copy[f];
  return copy;
};
const query = (get) => {
  let sel = '';
  const q = { select(s) { sel = s; return q; }, then(res, rej) { return Promise.resolve(view(get(), sel)).then(res, rej); } };
  return q;
};
const RiderApplication = {
  findOne: (f) => query(() => [...store.values()].find((d) => d.phone === f.phone) || null),
  findById: (id) => query(() => store.get(String(id)) || null),
  create: async (doc) => {
    const d = { _id: nextId(), status: 'submitted', reviewNote: '', createdAt: new Date(), reviewedAt: null, ...doc };
    store.set(d._id, d);
    return { ...d };
  },
  findByIdAndUpdate: (id, upd) => query(() => {
    const d = store.get(String(id));
    if (!d) return null;
    Object.assign(d, upd.$set);
    return d;
  }),
};
const User = { findOne: () => query(() => null) };
const stubs = {
  [path.join(ROOT, 'models/RiderApplication.js')]: RiderApplication,
  [path.join(ROOT, 'models/User.js')]: User,
  'express-async-handler': (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
  bcryptjs: { hash: async (p) => 'bcrypt:' + p },
  mongoose: { Types: { ObjectId: { isValid: (v) => typeof v === 'string' && /^[a-f\d]{24}$/i.test(v) } } },
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
const { submitApplication, getApplicationStatus } = require(CONTROLLER);
Module._load = origLoad;
const realLog = console.log; console.log = () => {};

const run = async (fn, req) => {
  const out = { nextErr: null };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; if (!out.status) out.status = 200; return res; } };
  await Promise.race([
    fn({ params: {}, body: {}, query: {}, ...req }, res, (e) => { out.nextErr = e || new Error('next()'); }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('handler hung')), 500)),
  ]);
  return out;
};
const BODY = { name: 'Test Rider', phone: '9876543210', password: 'password123', vehicleType: 'bike', deliveryZone: 'Zone A' };
const submit = (extra) => run(submitApplication, { body: { ...BODY, ...extra } });
const status = (id, extra) => run(getApplicationStatus, { params: { id }, ...extra });
const expect404 = (r, label) => {
  assert.strictEqual(r.nextErr, null, `${label}: handler threw (${r.nextErr && r.nextErr.message})`);
  assert.strictEqual(r.status, 404, `${label}: expected 404, got ${r.status}`);
  assert.deepStrictEqual(r.body, { success: false, message: 'Application not found.' }, `${label}: body differs`);
};
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

(async () => {
  let pass = 0;
  const t = async (name, fn) => { store.clear(); await fn(); pass++; realLog('PASS', name); };

  await t('A: submit returns a random statusToken once; only its sha256 is stored', async () => {
    const r = await submit();
    assert.strictEqual(r.nextErr, null);
    assert.strictEqual(r.status, 201);
    const token = r.body.data.statusToken;
    assert.ok(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token), 'statusToken must be 64 hex chars');
    assert.deepStrictEqual(Object.keys(r.body.data).sort(), ['id', 'name', 'statusToken', 'status'].sort());
    const stored = store.get(r.body.data.id);
    assert.strictEqual(stored.statusTokenHash, sha(token), 'stored value must be the sha256 of the token');
    assert.notStrictEqual(stored.statusTokenHash, token, 'the plain token must never be stored');
    assert.ok(!JSON.stringify(r.body).includes(stored.passwordHash));
    const r2 = await submit({ phone: '9876543211' });
    assert.notStrictEqual(r2.body.data.statusToken, token, 'every application needs its own token');
  });

  await t('B: id + correct token (query or body) returns the status; phone is not needed', async () => {
    const r = await submit();
    const { id, statusToken } = r.body.data;
    for (const req of [{ query: { statusToken } }, { body: { statusToken } }, { query: { statusToken: ` ${statusToken} `, phone: '0000000000' } }]) {
      const s = await status(id, req);
      assert.strictEqual(s.nextErr, null);
      assert.strictEqual(s.status, 200);
      assert.deepStrictEqual(Object.keys(s.body.data).sort(), ['createdAt', 'id', 'name', 'reviewNote', 'reviewedAt', 'status']);
      assert.strictEqual(s.body.data.status, 'submitted');
      assert.strictEqual(s.body.data.name, 'Test Rider');
    }
  });

  await t('C: wrong token / unknown id / old application with no hash / odd stored hash -> the same plain 404', async () => {
    const r = await submit();
    const { id } = r.body.data;
    const wrong = await status(id, { query: { statusToken: 'nope' } });
    expect404(wrong, 'wrong token');
    const missing = await status('f'.repeat(24), { query: { statusToken: 'nope' } });
    expect404(missing, 'unknown id');
    assert.deepStrictEqual(wrong, missing, 'wrong token and unknown id must look identical');
    store.set(id, { ...store.get(id), statusTokenHash: undefined });
    expect404(await status(id, { query: { statusToken: 'anything' } }), 'old application, no hash');
    for (const bad of [null, '', 'abc', 'x'.repeat(65), 12345, {}, ['a']]) {
      store.set(id, { ...store.get(id), statusTokenHash: bad });
      expect404(await status(id, { query: { statusToken: 'anything' } }), `stored hash ${JSON.stringify(bad)}`);
    }
    store.set(id, { ...store.get(id), statusTokenHash: sha('real') });
    for (const tok of [{ a: 'real' }, ['real', 'real']]) expect404(await status(id, { query: { statusToken: tok } }), 'odd token type ' + JSON.stringify(tok));
  });

  await t('D: id + phone alone (the old way) gets nothing; bad id / blank token -> 400', async () => {
    const r = await submit();
    const { id } = r.body.data;
    const old = await status(id, { query: { phone: BODY.phone } });
    assert.strictEqual(old.status, 400);
    assert.ok(!('data' in old.body), 'phone alone must not return any application data');
    assert.strictEqual((await status('not-an-id', { query: { statusToken: 'abc' } })).status, 400);
    assert.strictEqual((await status(id, { query: { statusToken: '   ' } })).status, 400);
    assert.strictEqual((await status(id, {})).status, 400);
  });

  await t('E: duplicate application 409 returns no applicationId and no status', async () => {
    const first = await submit();
    const { id, statusToken } = first.body.data;
    const hashBefore = store.get(id).statusTokenHash;
    for (const st of ['submitted', 'under_review', 'needs_changes', 'approved']) {
      store.get(id).status = st;
      const r = await submit({ name: 'Someone Else' });
      assert.strictEqual(r.nextErr, null);
      assert.strictEqual(r.status, 409, `status ${st}`);
      assert.deepStrictEqual(Object.keys(r.body).sort(), ['message', 'success'], `409 for ${st} has extra fields`);
      assert.strictEqual(r.body.success, false);
      const text = JSON.stringify(r.body);
      assert.ok(!text.includes(id), 'applicationId leaked');
      assert.ok(!text.includes(st), `status ${st} leaked`);
      assert.strictEqual(store.get(id).statusTokenHash, hashBefore, 'the owner token must not change on a blocked duplicate');
    }
    assert.strictEqual((await status(id, { query: { statusToken } })).status, 200, 'owner token still works');
  });

  await t('F: re-applying after rejected/withdrawn rotates the token (old stops, new works)', async () => {
    for (const st of ['rejected', 'withdrawn']) {
      store.clear();
      const first = await submit();
      const { id, statusToken: oldToken } = first.body.data;
      store.get(id).status = st;
      const again = await submit({ name: 'Renewed Rider' });
      assert.strictEqual(again.status, 201, st);
      assert.strictEqual(again.body.data.id, id);
      const newToken = again.body.data.statusToken;
      assert.ok(/^[a-f0-9]{64}$/.test(newToken));
      assert.notStrictEqual(newToken, oldToken, `${st}: token must rotate`);
      assert.strictEqual(store.get(id).statusTokenHash, sha(newToken));
      expect404(await status(id, { query: { statusToken: oldToken } }), `${st}: old token`);
      const ok = await status(id, { query: { statusToken: newToken } });
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(ok.body.data.status, 'submitted');
    }
  });

  await t('G: static checks on active code (select:false hash, constant-time compare, hash never selected elsewhere)', async () => {
    const model = stripComments(fs.readFileSync(path.join(ROOT, 'models/RiderApplication.js'), 'utf8'));
    assert.ok(/statusTokenHash:\s*\{[^}]*type:\s*String[^}]*select:\s*false[^}]*\}/.test(model), 'model needs statusTokenHash {type:String, select:false}');
    const ctl = stripComments(fs.readFileSync(CONTROLLER, 'utf8'));
    const a = ctl.indexOf('exports.getApplicationStatus');
    const b = ctl.indexOf('exports.listApplications');
    assert.ok(a > 0 && b > a);
    const statusFn = ctl.slice(a, b);
    assert.ok(/\.select\(\s*['"]\+statusTokenHash['"]\s*\)/.test(statusFn), 'status handler must select +statusTokenHash');
    assert.ok(/crypto\.timingSafeEqual\(/.test(statusFn), 'status handler must compare with crypto.timingSafeEqual');
    assert.ok(!/phone/.test(statusFn), 'status handler must not use the phone');
    assert.strictEqual((ctl.match(/\+statusTokenHash/g) || []).length, 1, '+statusTokenHash may only be selected once, in the status handler');
    assert.ok(!/statusTokenHash/.test(ctl.slice(b)), 'admin list/review handlers must not touch the hash');
  });

  realLog(`\n${pass} scenarios passed`);
})().catch((e) => { realLog('FAIL', e && e.message ? e.message : e); process.exit(1); });

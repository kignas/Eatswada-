// Regression test: customer-supplied image URLs must come from OUR Cloudinary cloud.
// Before: review photos (orderController.submitReview, incl. per-item photos) only checked the URL started with
// https://res.cloudinary.com/, and support attachments (utils/supportHelpers.cleanAttachments) only checked the
// host, so a customer could attach a file hosted in ANY Cloudinary account (someone else's cloud, or their own
// cloud serving whatever they like) and our apps / admin console would render it as trusted evidence.
// Now the path must start with /<CLOUDINARY_CLOUD_NAME>/ (checked on the parsed URL, so userinfo, ports,
// look-alike hosts, ../ tricks and prefix look-alikes fail); if the cloud name is not configured nothing passes.
// Runs with no database (in-memory fakes). Usage: npm run test:cloudinary-own-cloud
const Module = require('module');
const path = require('path');
const assert = require('assert');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const CONTROLLER = path.join(ROOT, 'controllers/orderController.js');
const CLOUD = 'eatswada-cloud';
process.env.CLOUDINARY_CLOUD_NAME = CLOUD;
delete process.env.SUPPORT_ATTACHMENT_HOSTS;

// ── in-memory models (same approach as tests/review-moderation.js) ───────────────
const reviews = new Map();
function Review(data) {
  Object.assign(this, { isVisible: true, adminNote: '' }, data);
  this.save = async () => { reviews.set(String(this.order), this); return this; };
}
Review.findOne = async (filter) => reviews.get(String(filter.order)) || null;
Review.aggregate = async () => [];
const order = { _id: 'O1', user: 'U1', status: 'delivered', restaurant: 'R1', items: [{ name: 'Burger', menuItem: 'M1' }], save: async () => order };
const Order = { findOne: async () => order };
const Restaurant = { findByIdAndUpdate: async () => {} };
const stubs = {
  [path.join(ROOT, 'models/Review.js')]: Review,
  [path.join(ROOT, 'models/Order.js')]: Order,
  [path.join(ROOT, 'models/Restaurant.js')]: Restaurant,
  'express-async-handler': (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
};
const anything = new Proxy(function () {}, { get: (t, p) => (p === 'then' ? undefined : anything), apply: () => anything, construct: () => anything });
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (parent && parent.filename === CONTROLLER && request !== 'crypto') {
    const resolved = request.startsWith('.') ? path.resolve(path.dirname(CONTROLLER), request) + '.js' : request;
    if (resolved === path.join(ROOT, 'utils/cloudinaryUrl.js')) return origLoad.call(this, request, parent, ...rest);
    return stubs[resolved] || stubs[request] || anything;
  }
  return origLoad.call(this, request, parent, ...rest);
};
const { submitReview } = require(CONTROLLER);
Module._load = origLoad;
const realLog = console.log; console.log = () => {};

const call = async (body) => {
  const out = {};
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; if (!out.status) out.status = 200; return res; } };
  let err = null;
  await submitReview({ params: { id: 'O1' }, user: { _id: 'U1' }, body }, res, (e) => { err = e; });
  if (err) throw err;
  return out;
};
const own = (p = 'image/upload/v1/Eatswada/customer-media/U1/a.jpg') => `https://res.cloudinary.com/${CLOUD}/${p}`;
const LOOKALIKES = [
  `https://res.cloudinary.com/attacker-cloud/image/upload/v1/a.jpg`,   // someone else's Cloudinary account
  `https://res.cloudinary.com/${CLOUD}-evil/image/upload/v1/a.jpg`,     // cloud-name prefix look-alike
  `https://res.cloudinary.com/${CLOUD}x/image/upload/v1/a.jpg`,
  `https://res.cloudinary.com/${CLOUD}`,                                // no trailing path
  `https://res.cloudinary.com/${CLOUD}/../attacker-cloud/image/upload/v1/a.jpg`,
  `https://res.cloudinary.com/${CLOUD}/%2e%2e/attacker-cloud/image/upload/v1/a.jpg`,
  `https://res.cloudinary.com/%2e%2e/attacker-cloud/${CLOUD}/a.jpg`,
  `http://res.cloudinary.com/${CLOUD}/image/upload/v1/a.jpg`,           // not https
  `https://res.cloudinary.com.evil.com/${CLOUD}/image/upload/v1/a.jpg`, // host look-alike
  `https://evil.com/${CLOUD}/image/upload/v1/a.jpg`,
  `https://evil.res.cloudinary.com/${CLOUD}/image/upload/v1/a.jpg`,     // sub-domain of the host
  `https://res.cloudinary.com@evil.com/${CLOUD}/image/upload/v1/a.jpg`, // userinfo trick
  `https://user:pw@res.cloudinary.com/${CLOUD}/image/upload/v1/a.jpg`,
  `https://res.cloudinary.com:8443/${CLOUD}/image/upload/v1/a.jpg`,     // port
  `//res.cloudinary.com/${CLOUD}/image/upload/v1/a.jpg`,
  `javascript:alert(1)//res.cloudinary.com/${CLOUD}/`,
  `data:image/png;base64,AAAA`,
  `https://res.cloudinary.com/${CLOUD}/` + 'a'.repeat(1000),            // over 1000 chars
  'not a url', '', '   ',
];
const reset = () => { reviews.clear(); process.env.CLOUDINARY_CLOUD_NAME = CLOUD; };

(async () => {
  let pass = 0;
  const t = async (name, fn) => { reset(); await fn(); pass++; realLog('PASS', name); };

  await t('A: review photos from another Cloudinary account are rejected (400) and nothing is saved', async () => {
    const r = await call({ score: 5, photos: [own(), 'https://res.cloudinary.com/attacker-cloud/image/upload/v1/a.jpg'] });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(reviews.size, 0);
  });

  await t('B: review photos from our cloud are accepted and stored', async () => {
    const photos = [own(), own('image/upload/f_auto,q_auto/v2/Eatswada/customer-media/U1/b.png')];
    const r = await call({ score: 5, photos });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual([...reviews.get('O1').photos], photos);
  });

  await t('B2: stored value is the normalised URL (lower-cased scheme/host, encoded spaces)', async () => {
    const r = await call({ score: 5, photos: ['HTTPS://RES.Cloudinary.com/' + CLOUD + '/image/upload/v1/a b.jpg'] });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual([...reviews.get('O1').photos], [own('image/upload/v1/a%20b.jpg')]);
  });

  await t('C: every look-alike URL is rejected as a review photo', async () => {
    for (const url of LOOKALIKES.filter(u => u.trim())) { // blank entries are ignored by design (as before)
      reviews.clear();
      const r = await call({ score: 5, photos: [url] }).catch((e) => ({ status: 'threw ' + e.message }));
      assert.strictEqual(r.status, 400, `accepted review photo: ${JSON.stringify(url).slice(0, 120)} (status ${r.status})`);
      assert.strictEqual(reviews.size, 0);
    }
    for (const bad of [{ a: 1 }, ['x'], 42, [own()], { toString: () => own() }]) {
      const r = await call({ score: 5, photos: [bad] });
      assert.strictEqual(r.status, 400, `accepted non-string photo ${JSON.stringify(bad)}`);
    }
  });

  await t('D: per-item photos keep only our cloud (others are dropped, review still saved)', async () => {
    const keep = own('image/upload/v1/Eatswada/customer-media/U1/item.jpg');
    const r = await call({ score: 4, itemRatings: [{ itemName: 'Burger', score: 5, photos: [keep, ...LOOKALIKES.slice(0, 6)] }] });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual([...reviews.get('O1').itemRatings[0].photos], [keep]);
  });

  await t('D2: per-item photos are capped at 3', async () => {
    const five = [1, 2, 3, 4, 5].map(n => own(`image/upload/v1/${n}.jpg`));
    await call({ score: 4, itemRatings: [{ itemName: 'Burger', score: 5, photos: five }] });
    assert.deepStrictEqual([...reviews.get('O1').itemRatings[0].photos], five.slice(0, 3));
  });

  await t('E: if CLOUDINARY_CLOUD_NAME is not configured, no photo is accepted (fail closed)', async () => {
    delete process.env.CLOUDINARY_CLOUD_NAME;
    assert.strictEqual((await call({ score: 5, photos: [own()] })).status, 400);
    assert.strictEqual((await call({ score: 5, photos: ['https://res.cloudinary.com//image/upload/v1/a.jpg'] })).status, 400, 'empty cloud name must not match a // path');
    reviews.clear();
    const r = await call({ score: 5, itemRatings: [{ itemName: 'Burger', score: 5, photos: [own()] }] });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual([...reviews.get('O1').itemRatings[0].photos], []);
  });

  await t('F: reviews without photos, and the 4-photo limit, behave as before', async () => {
    assert.strictEqual((await call({ score: 5, comment: 'ok' })).status, 201);
    reviews.clear();
    assert.strictEqual((await call({ score: 5, photos: ['', '   ', null, own()] })).status, 201);
    assert.deepStrictEqual([...reviews.get('O1').photos], [own()], 'blank entries are ignored, the real photo is kept');
    reviews.clear();
    assert.strictEqual((await call({ score: 5, photos: [own(), own(), own(), own(), own()] })).status, 400);
    assert.strictEqual((await call({ score: 5, photos: [own(), own(), own(), own()] })).status, 201);
  });

  await t('G: support attachments (cleanAttachments) keep only our cloud', async () => {
    const { cleanAttachments } = require(path.join(ROOT, 'utils/supportHelpers.js'));
    assert.deepStrictEqual(cleanAttachments([own(), ...LOOKALIKES]), [own()]);
    const four = [own('a/1.jpg'), own('a/2.jpg'), own('a/3.jpg'), own('a/4.jpg')];
    assert.deepStrictEqual(cleanAttachments(four), four.slice(0, 3), 'max 3 attachments');
    assert.deepStrictEqual(cleanAttachments('nope'), []);
    delete process.env.CLOUDINARY_CLOUD_NAME;
    assert.deepStrictEqual(cleanAttachments([own()]), [], 'fail closed without a cloud name');
  });

  await t('G2: with SUPPORT_ATTACHMENT_HOSTS override other hosts still work (https only) and Cloudinary stays own-cloud only', async () => {
    process.env.SUPPORT_ATTACHMENT_HOSTS = 'res.cloudinary.com, cdn.example.com';
    const file = path.join(ROOT, 'utils/supportHelpers.js');
    delete require.cache[file];
    const { cleanAttachments } = require(file);
    delete process.env.SUPPORT_ATTACHMENT_HOSTS;
    delete require.cache[file];
    const cdn = 'https://cdn.example.com/pics/1.jpg';
    const got = cleanAttachments([own(), cdn, 'http://cdn.example.com/pics/2.jpg', 'https://evil.com/3.jpg', 'https://res.cloudinary.com/attacker-cloud/image/upload/v1/a.jpg', 'https://sub.cdn.example.com/4.jpg']);
    assert.deepStrictEqual(got, [own(), cdn, 'https://sub.cdn.example.com/4.jpg']);
  });

  await t('H: helper utils/cloudinaryUrl.normalizeOwnCloudinaryUrl', async () => {
    const { normalizeOwnCloudinaryUrl } = require(path.join(ROOT, 'utils/cloudinaryUrl.js'));
    assert.strictEqual(normalizeOwnCloudinaryUrl(own()), own());
    assert.strictEqual(normalizeOwnCloudinaryUrl('  ' + own() + '  '), own());
    for (const url of LOOKALIKES) assert.strictEqual(normalizeOwnCloudinaryUrl(url), null, JSON.stringify(url).slice(0, 100));
    for (const bad of [undefined, null, 42, {}, [], [own()], { toString: () => own() }]) assert.strictEqual(normalizeOwnCloudinaryUrl(bad), null);
    assert.strictEqual(normalizeOwnCloudinaryUrl('HTTPS://RES.Cloudinary.com/' + CLOUD + '/a b.jpg'), 'https://res.cloudinary.com/' + CLOUD + '/a%20b.jpg', 'returns the normalised href');
    process.env.CLOUDINARY_CLOUD_NAME = '  ' + CLOUD + '  ';
    assert.strictEqual(normalizeOwnCloudinaryUrl(own()), own(), 'cloud name from env is trimmed');
    process.env.CLOUDINARY_CLOUD_NAME = CLOUD;
    assert.strictEqual(normalizeOwnCloudinaryUrl(own(), 10), null, 'custom max length');
    delete process.env.CLOUDINARY_CLOUD_NAME;
    assert.strictEqual(normalizeOwnCloudinaryUrl(own()), null);
    assert.strictEqual(normalizeOwnCloudinaryUrl('https://res.cloudinary.com//image/upload/v1/a.jpg'), null, 'no cloud name must not match a // path');
    process.env.CLOUDINARY_CLOUD_NAME = '   ';
    assert.strictEqual(normalizeOwnCloudinaryUrl(own()), null);
  });

  await t('I: static — no hard-coded res.cloudinary.com prefix check is left in review/support code', async () => {
    const strip = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const order = strip('controllers/orderController.js');
    const body = order.slice(order.indexOf('const submitReview'), order.indexOf('const rateOrder'));
    assert.ok(body.length > 500, 'could not isolate submitReview');
    assert.ok(!/res\\?\.cloudinary/i.test(body), 'submitReview still has a host-only Cloudinary regex');
    assert.ok(/normalizeOwnCloudinaryUrl/.test(body));
    assert.ok(/normalizeOwnCloudinaryUrl/.test(strip('utils/supportHelpers.js')));
  });

  realLog(`\n${pass} scenarios passed`);
})().catch((e) => { realLog('FAIL', e && e.message ? e.message : e); process.exit(1); });

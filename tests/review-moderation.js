// Regression test: a customer editing their review must NOT undo admin moderation.
// Before: submitReview (orders/:id/review) set isVisible=true and adminNote='' on every edit, so a
// review an admin hid for abuse came back after the customer re-saved it (and counted in the
// restaurant rating again). Now: the edit is saved but visibility / admin note are untouched.
// Runs with no database (in-memory fakes). Usage: npm run test:review-moderation
const Module = require('module');
const path = require('path');
const assert = require('assert');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const CONTROLLER = path.join(ROOT, 'controllers/orderController.js');

// ── in-memory models ─────────────────────────────────────────────────────────────
const reviews = new Map(); // orderId -> doc
let aggregateMatches = [];
function Review(data) {
  Object.assign(this, { isVisible: true, adminNote: '' }, data);
  this.save = async () => { reviews.set(String(this.order), this); return this; };
}
Review.findOne = async (filter) => reviews.get(String(filter.order)) || null;
Review.aggregate = async (pipeline) => {
  aggregateMatches.push(pipeline[0].$match);
  const visible = [...reviews.values()].filter(r => r.isVisible);
  return visible.length ? [{ avg: visible.reduce((s, r) => s + r.score, 0) / visible.length, count: visible.length }] : [];
};
const order = { _id: 'O1', user: 'U1', status: 'delivered', restaurant: 'R1', items: [], save: async () => order };
const Order = { findOne: async () => order };
const restaurantUpdates = [];
const Restaurant = { findByIdAndUpdate: async (id, patch) => { restaurantUpdates.push(patch); } };
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
const reset = () => { reviews.clear(); aggregateMatches = []; restaurantUpdates.length = 0; };

(async () => {
  let pass = 0;
  const t = async (name, fn) => { reset(); await fn(); pass++; realLog('PASS', name); };

  await t('A: first review is created visible (201)', async () => {
    const r = await call({ score: 5, comment: 'great' });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(reviews.get('O1').isVisible, true);
  });

  await t('B: editing a normal review keeps it visible (200)', async () => {
    await call({ score: 5, comment: 'great' });
    const r = await call({ score: 4, comment: 'good' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(reviews.get('O1').isVisible, true);
    assert.strictEqual(reviews.get('O1').score, 4);
  });

  await t('C: editing a HIDDEN review keeps it hidden and keeps the admin note', async () => {
    await call({ score: 1, comment: 'abusive text' });
    const rev = reviews.get('O1');
    rev.isVisible = false; rev.adminNote = 'abusive language';
    const r = await call({ score: 2, comment: 'still rude' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(rev.isVisible, false, 'edit un-hid a moderated review');
    assert.strictEqual(rev.adminNote, 'abusive language', 'edit wiped the admin note');
  });

  await t('D: the edit itself is still saved on a hidden review', async () => {
    await call({ score: 1, comment: 'abusive text' });
    reviews.get('O1').isVisible = false;
    await call({ score: 3, comment: 'sorry, polite now' });
    assert.strictEqual(reviews.get('O1').score, 3);
    assert.strictEqual(reviews.get('O1').comment, 'sorry, polite now');
  });

  await t('E: a hidden review stays out of the restaurant rating after an edit', async () => {
    await call({ score: 1, comment: 'abusive text' });
    reviews.get('O1').isVisible = false;
    const r = await call({ score: 5, comment: 'edited' });
    assert.strictEqual(r.body.restaurantRating.ratingCount, 0);
    assert.strictEqual(restaurantUpdates[restaurantUpdates.length - 1].ratingCount, 0);
    assert.ok(aggregateMatches.every(m => m.isVisible === true), 'rating must only count visible reviews');
  });

  await t('F: static — submitReview no longer assigns isVisible or adminNote', async () => {
    const src = fs.readFileSync(CONTROLLER, 'utf8');
    const body = src.slice(src.indexOf('const submitReview'), src.indexOf('const rateOrder'));
    assert.ok(body.length > 200, 'could not isolate submitReview');
    assert.ok(!/review\.isVisible\s*=/.test(body), 'submitReview still assigns review.isVisible');
    assert.ok(!/review\.adminNote\s*=/.test(body), 'submitReview still assigns review.adminNote');
  });

  realLog(`review-moderation: ${pass} scenarios passed`);
})().catch((e) => { console.log = realLog; console.error('FAIL', e.message); process.exit(1); });

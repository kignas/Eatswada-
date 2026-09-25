// In-memory Order model used only by tests/payment-fixes.js.
// It intentionally implements the small Mongoose surface exercised by the
// payment/refund regression tests, including atomic-style update operations.

const clone = (value) => {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
};

const getPath = (obj, path) => {
  const walk = (value, parts) => {
    if (!parts.length) return value;
    if (Array.isArray(value)) return value.map(v => walk(v, parts)).flat();
    if (value == null) return undefined;
    return walk(value[parts[0]], parts.slice(1));
  };
  return walk(obj, path.split('.'));
};

const setPath = (obj, path, value) => {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = clone(value);
};

const valuesEqual = (a, b) => {
  if (Array.isArray(a)) return a.some(v => valuesEqual(v, b));
  return JSON.stringify(a) === JSON.stringify(b);
};

function matchesCondition(actual, condition, exists) {
  if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
    for (const [op, expected] of Object.entries(condition)) {
      if (op === '$exists') {
        if (exists !== Boolean(expected)) return false;
      } else if (op === '$nin') {
        if (expected.some(v => valuesEqual(actual, v) || (Array.isArray(actual) && actual.some(x => valuesEqual(x, v))))) return false;
      } else if (op === '$ne') {
        if (valuesEqual(actual, expected)) return false;
      } else if (op === '$in') {
        if (!(expected.some(v => valuesEqual(actual, v) || (Array.isArray(actual) && actual.some(x => valuesEqual(x, v)))))) return false;
      } else {
        return false;
      }
    }
    return true;
  }
  return valuesEqual(actual, condition);
}

function matches(doc, filter = {}) {
  for (const [key, condition] of Object.entries(filter)) {
    if (key === '$or') {
      if (!condition.some(branch => matches(doc, branch))) return false;
      continue;
    }
    const actual = getPath(doc, key);
    const exists = actual !== undefined;
    if (!matchesCondition(actual, condition, exists)) return false;
  }
  return true;
}

function applyUpdate(doc, update) {
  if (update.$set) {
    for (const [path, value] of Object.entries(update.$set)) {
      const positional = path.match(/^(.+)\.\$\.(.+)$/);
      if (positional) {
        const arr = getPath(doc, positional[1]);
        if (Array.isArray(arr)) {
          // The production query uses this positional update only after the
          // array element is identified by the same filter.
          const filterField = positional[1] + '.paymentId';
          const paymentId = update.__positionalPaymentId;
          const idx = paymentId == null ? 0 : arr.findIndex(x => String(x.paymentId) === String(paymentId));
          if (idx >= 0) setPath(arr[idx], positional[2], value);
        }
      } else {
        setPath(doc, path, value);
      }
    }
  }
  if (update.$push) {
    for (const [path, value] of Object.entries(update.$push)) {
      const arr = getPath(doc, path);
      if (!Array.isArray(arr)) setPath(doc, path, []);
      getPath(doc, path).push(clone(value));
    }
  }
  if (update.$addToSet) {
    for (const [path, value] of Object.entries(update.$addToSet)) {
      let arr = getPath(doc, path);
      if (!Array.isArray(arr)) { setPath(doc, path, []); arr = getPath(doc, path); }
      if (!arr.some(v => valuesEqual(v, value))) arr.push(clone(value));
    }
  }
  return doc;
}

class Query {
  constructor(fn) { this.fn = fn; }
  sort(spec = {}) { this.sortSpec = spec; return this; }
  select() { return this; }
  lean() { return Promise.resolve(clone(this.fn())); }
  then(resolve, reject) { return Promise.resolve(this.fn()).then(resolve, reject); }
  catch(reject) { return Promise.resolve(this.fn()).catch(reject); }
}

function wrapDoc(doc) {
  if (!doc) return null;
  if (typeof doc.set === 'function') return doc;
  doc.set = function(path, value) { setPath(this, path, value); };
  return doc;
}

function makeOrderModel() {
  const model = {
    docs: [],
    insert(input) {
      const doc = wrapDoc(clone(input));
      if (!doc.createdAt) doc.createdAt = new Date().toISOString();
      if (!doc.refund) doc.refund = { status: 'none' };
      if (!doc.duplicatePayments) doc.duplicatePayments = [];
      if (!doc.razorpayOrderIdHistory) doc.razorpayOrderIdHistory = [];
      if (doc.paymentClaimId === undefined) doc.paymentClaimId = '';
      this.docs.push(doc);
      return doc;
    },
    get(id) { return this.docs.find(d => String(d._id) === String(id)); },
    find(filter = {}) {
      return new Query(() => {
        let out = this.docs.filter(d => matches(d, filter));
        if (this._sortSpec) out = out.slice().sort((a, b) => {
          for (const [key, dir] of Object.entries(this._sortSpec)) {
            const av = getPath(a, key), bv = getPath(b, key);
            if (av < bv) return -1 * dir;
            if (av > bv) return 1 * dir;
          }
          return 0;
        });
        return out;
      });
    },
    findOne(filter = {}) { return new Query(() => this.docs.find(d => matches(d, filter)) || null); },
    findById(id) { return new Query(() => this.get(id) || null); },
    findOneAndUpdate(filter, update) {
      // Synchronous claim/update before the returned promise yields, matching
      // Mongo's atomic findOneAndUpdate behavior for these single-document tests.
      const doc = this.docs.find(d => matches(d, filter));
      if (!doc) return Promise.resolve(null);
      applyUpdate(doc, update);
      return Promise.resolve(wrapDoc(doc));
    },
    updateMany(filter, update) {
      const matched = this.docs.filter(d => matches(d, filter));
      matched.forEach(d => {
        const positionalPayment = filter['duplicatePayments.paymentId'];
        const paymentId = positionalPayment && typeof positionalPayment === 'object' && positionalPayment.$ne !== undefined
          ? null
          : (typeof positionalPayment === 'string' ? positionalPayment : null);
        applyUpdate(d, { ...update, __positionalPaymentId: paymentId });
      });
      return Promise.resolve({ matchedCount: matched.length, modifiedCount: matched.length });
    },
    updateOne(filter, update) {
      const doc = this.docs.find(d => matches(d, filter));
      if (!doc) return Promise.resolve({ matchedCount: 0, modifiedCount: 0 });
      applyUpdate(doc, update);
      return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
    },
  };

  // Keep sort() independent of the model instance and compatible with the
  // tiny query API above.
  const originalFind = model.find;
  model.find = function(filter = {}) {
    const q = originalFind.call(this, filter);
    const originalSort = q.sort.bind(q);
    q.sort = (spec = {}) => {
      q.fn = (() => {
        const base = q.fn;
        return () => {
          const out = base();
          return out.slice().sort((a, b) => {
            for (const [key, dir] of Object.entries(spec)) {
              const av = getPath(a, key), bv = getPath(b, key);
              if (av < bv) return -1 * dir;
              if (av > bv) return 1 * dir;
            }
            return 0;
          });
        };
      })();
      return q;
    };
    return q;
  };

  return model;
}

module.exports = { makeOrderModel };

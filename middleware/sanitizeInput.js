'use strict';

// Replaces the deprecated, unmaintained `xss-clean` package with the same protection and
// no dependency: every string in req.body and req.query has "<" escaped to "&lt;", so text
// that looks like an HTML tag (<script>, <img onerror=...>) is stored as harmless text.
//
//  - Only "<" is escaped (that is enough to stop a tag from opening). "&", quotes, ">" and
//    unicode are left alone so names like "Biryani & Co." are stored as typed.
//  - Idempotent: running it twice never double-escapes.
//  - Values are edited in place on the same objects; keys, numbers, booleans, null, dates
//    and Buffers (e.g. the raw Razorpay webhook body) are never touched.
//  - Iterative with a visited set, so deeply nested or cyclic input cannot overflow the
//    stack or loop forever.

function isPlain(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeTree(root) {
  if (!isPlain(root)) return;
  const seen = new WeakSet([root]);
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === 'string') {
        if (value.indexOf('<') !== -1) node[key] = value.replace(/</g, '&lt;');
      } else if (isPlain(value) && !seen.has(value)) {
        seen.add(value);
        stack.push(value);
      }
    }
  }
}

function sanitizeInput(req, res, next) {
  sanitizeTree(req.body);
  sanitizeTree(req.query);
  next();
}

module.exports = sanitizeInput;
module.exports.sanitizeTree = sanitizeTree;

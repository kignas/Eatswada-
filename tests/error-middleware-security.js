'use strict';
const assert = require('assert');
const { errorHandler, notFound } = require('../middleware/errorMiddleware');

function invoke(err, env = 'production', headersSent = false) {
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = env;
  const response = { statusCode: null, body: null, headersSent,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
  let forwarded;
  const oldError = console.error;
  console.error = () => {};
  try {
    errorHandler(err, { method: 'GET', path: '/api/test', originalUrl: '/api/test?token=do-not-log' }, response, e => { forwarded = e; });
  } finally {
    console.error = oldError;
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
  }
  return { response, forwarded };
}

let result = invoke(Object.assign(new Error('database password leaked'), { status: 500 }));
assert.strictEqual(result.response.statusCode, 500);
assert.deepStrictEqual(result.response.body, { success: false, message: 'Internal Server Error' });
assert.ok(!('stack' in result.response.body));

result = invoke(Object.assign(new Error('bad custom status'), { statusCode: 200 }));
assert.strictEqual(result.response.statusCode, 500);
assert.strictEqual(result.response.body.message, 'Internal Server Error');

result = invoke(Object.assign(new Error('not found'), { statusCode: 404 }));
assert.strictEqual(result.response.statusCode, 404);
assert.strictEqual(result.response.body.message, 'not found');

const sentinel = new Error('stream already started');
result = invoke(sentinel, 'production', true);
assert.strictEqual(result.forwarded, sentinel);
assert.strictEqual(result.response.body, null);

let passed;
notFound({}, {}, e => { passed = e; });
assert.strictEqual(passed.statusCode, 404);
console.log('Error middleware security: 5 passed, 0 failed');

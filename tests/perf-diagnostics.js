#!/usr/bin/env node
'use strict';
// Tests for utils/perfDiagnostics.js (opt-in, PERF_DIAGNOSTICS=true) and its
// wiring in config/db.js. No database, no npm packages. Usage:
//   node tests/perf-diagnostics.js

const Module = require('module');
const path = require('path');
const assert = require('assert');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const DIAG = path.join(ROOT, 'utils/perfDiagnostics.js');
const DB = path.join(ROOT, 'config/db.js');
let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`PASS ${name}`); }

function load(file, env) {
  delete require.cache[file];
  delete require.cache[DIAG];
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return require(file); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

function fakeReq(method, url) { return { method, originalUrl: url, url }; }
function fakeRes() { return new EventEmitter(); }
function captureLogs(fn) {
  const lines = []; const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { return { value: fn(), lines }; } finally { console.log = orig; }
}

(async () => {
  await check('disabled by default: nothing enabled, no timer started on require', async () => {
    const d = load(DIAG, { PERF_DIAGNOSTICS: undefined });
    assert.strictEqual(d.enabled, false);
    assert.strictEqual(load(DIAG, { PERF_DIAGNOSTICS: 'false' }).enabled, false);
    assert.strictEqual(load(DIAG, { PERF_DIAGNOSTICS: 'TRUE' }).enabled, true);
  });

  const d = load(DIAG, { PERF_DIAGNOSTICS: 'true' });

  await check('route labels: /api/v1 folded into /api, ObjectIds -> :id, query dropped', async () => {
    assert.strictEqual(d.routeLabel(fakeReq('GET', '/api/v1/restaurants/65f1a2b3c4d5e6f708192a3b/menu?x=1')), 'GET /api/restaurants/:id/menu');
    assert.strictEqual(d.routeLabel(fakeReq('GET', '/api/orders?page=1&limit=10')), 'GET /api/orders');
    assert.strictEqual(d.routeLabel(fakeReq('POST', '/api/cart/add')), 'POST /api/cart/add');
  });

  await check('middleware records each request once (finish + close) and calls next()', async () => {
    let nextCalls = 0;
    const res = fakeRes();
    d.middleware(fakeReq('GET', '/api/cart'), res, () => { nextCalls += 1; });
    res.emit('finish'); res.emit('close');
    const res2 = fakeRes();
    d.middleware(fakeReq('GET', '/api/cart'), res2, () => { nextCalls += 1; });
    res2.emit('close'); // client went away
    assert.strictEqual(nextCalls, 2);
    const { value } = captureLogs(() => d.report());
    assert.strictEqual(value.routes['GET /api/cart'].n, 2);
    assert.strictEqual(value.requests, 2);
  });

  await check('MongoDB driver events are summarised; handshake commands ignored', async () => {
    const client = new EventEmitter();
    assert.strictEqual(d.attachMongo({ getClient: () => client }), true);
    for (const ms of [2, 4, 6, 100]) client.emit('commandSucceeded', { commandName: 'find', duration: ms });
    client.emit('commandSucceeded', { commandName: 'update', duration: 9 });
    client.emit('commandFailed', { commandName: 'find', duration: 1 });
    client.emit('commandSucceeded', { commandName: 'hello', duration: 1 });
    client.emit('connectionCreated', {});
    client.emit('connectionReady', { durationMS: 250 });
    client.emit('connectionCheckedOut', { durationMS: 3 });
    client.emit('connectionCheckOutFailed', {});
    const res = fakeRes();
    d.middleware(fakeReq('GET', '/api/users/profile'), res, () => {}); res.emit('finish');
    const { value, lines } = captureLogs(() => d.report());
    assert.strictEqual(value.db.commands, 6);
    assert.strictEqual(value.db.failed, 1);
    assert.deepStrictEqual(value.db.byCommand.find, { n: 5, p50: 4, p95: 100, max: 100 });
    assert.ok(!('hello' in value.db.byCommand));
    assert.strictEqual(value.db.connectionsCreated, 1);
    assert.strictEqual(value.db.connectionReadyMs.max, 250);
    assert.strictEqual(value.db.poolWaitMs.n, 1);
    assert.strictEqual(value.db.poolCheckoutFailed, 1);
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].startsWith('[PERF] '));
    const parsed = JSON.parse(lines[0].slice(7));
    for (const key of ['t', 'windowSec', 'requests', 'maxInFlight', 'eventLoopMs', 'cpu', 'memMB', 'db', 'routes']) assert.ok(key in parsed, key);
  });

  await check('idle window writes nothing', async () => {
    const { value, lines } = captureLogs(() => d.report());
    assert.strictEqual(value, null);
    assert.strictEqual(lines.length, 0);
  });

  await check('start()/stop() with a connection lacking a client never throws', async () => {
    const { lines } = captureLogs(() => { d.start({}); d.start({}); d.stop(); d.stop(); });
    assert.ok(lines.some((l) => l.includes('diagnostics enabled')));
    assert.strictEqual(d.attachMongo(null), false);
  });

  // ── config/db.js: identical connect options unless the flag is on ────────
  const connectCalls = [];
  const fakeMongoose = {
    connect: async (uri, opts) => { connectCalls.push(opts); return { connection: { host: 'fake' } }; },
    connection: { on() {} },
  };
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) { if (request === 'mongoose') return 'mongoose'; return origResolve.call(this, request, parent, ...rest); };
  require.cache.mongoose = { id: 'mongoose', filename: 'mongoose', loaded: true, exports: fakeMongoose };

  await check('config/db.js: diagnostics off -> same options as before (no monitorCommands)', async () => {
    const { lines } = captureLogs(() => null);
    void lines;
    const orig = console.log; console.log = () => {};
    try {
      await load(DB, { PERF_DIAGNOSTICS: undefined, MONGO_URI: 'mongodb://fake' })();
      await load(DB, { PERF_DIAGNOSTICS: 'true', MONGO_URI: 'mongodb://fake' })();
    } finally { console.log = orig; }
    const [off, on] = connectCalls;
    assert.deepStrictEqual(Object.keys(off).sort(), ['connectTimeoutMS', 'maxPoolSize', 'minPoolSize', 'serverSelectionTimeoutMS', 'socketTimeoutMS']);
    assert.deepStrictEqual(off, { maxPoolSize: 30, minPoolSize: 2, serverSelectionTimeoutMS: 10000, socketTimeoutMS: 45000, connectTimeoutMS: 10000 });
    const { monitorCommands, ...rest } = on;
    assert.strictEqual(monitorCommands, true);
    assert.deepStrictEqual(rest, off);
  });

  console.log(`perf-diagnostics: ${passed} passed, 0 failed`);
})().catch((err) => {
  console.error('FAIL', err && err.stack ? err.stack : err);
  console.log(`perf-diagnostics: ${passed} passed, 1 failed`);
  process.exit(1);
});

'use strict';

// Shared harness for the financial-integrity suites:
//
//   tests/financial-cod-delivery.test.js
//   tests/financial-payout.test.js
//   tests/financial-settlement.test.js
//   tests/financial-cross-cutting.test.js
//   tests/financial-standalone-fallback.test.js
//
// SAFETY MODEL
//   * Every database used here is a throw-away mongod started by
//     mongodb-memory-server on 127.0.0.1 with a random port and a random
//     database name. This file NEVER reads MONGO_URI (or any other env var) to
//     decide where to connect, so these suites cannot reach production,
//     Render, Atlas, or any shared database.
//   * Before connecting, the URI host is asserted to be loopback. If anything
//     else is ever produced, the harness aborts instead of connecting.
//   * Teardown is idempotent, time-boxed, and also runs on SIGINT/SIGTERM,
//     uncaught exceptions and unhandled rejections so mongod is not leaked.
//
// EXIT-CODE MODEL
//   * test() never throws; it records PASS/FAIL (including timeouts).
//   * finish() returns 0 only when at least one test ran and none failed.
//   * Harness-level failures (cannot start mongod, cannot connect, replica set
//     cannot run a transaction) throw from start*(), which the suites turn
//     into exit code 1.
//
// mongoose and mongodb-memory-server are required lazily so makeReq / makeRes /
// makeReporter can be exercised without installing either package.

const crypto = require('node:crypto');

const START_TIMEOUT_MS = Number(process.env.FIN_TEST_START_TIMEOUT_MS) || 180000; // first run may download mongod
const STOP_TIMEOUT_MS = Number(process.env.FIN_TEST_STOP_TIMEOUT_MS) || 20000;
const TEST_TIMEOUT_MS = Number(process.env.FIN_TEST_CASE_TIMEOUT_MS) || 60000;
const SUITE_TIMEOUT_MS = Number(process.env.FIN_TEST_SUITE_TIMEOUT_MS) || 600000;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

let activeServer = null;      // MongoMemoryReplSet | MongoMemoryServer
let activeKind = null;        // 'replset' | 'standalone'
let startPromise = null;
let stopPromise = null;
let handlersInstalled = false;
let watchdog = null;

// ── small utilities ───────────────────────────────────────────────────────

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function assertLoopbackUri(uri) {
  let host;
  try {
    // mongodb://127.0.0.1:27017/?replicaSet=rs0 -> URL parses this fine.
    host = new URL(uri).hostname;
  } catch (err) {
    throw new Error(`Refusing to connect: cannot parse test MongoDB URI (${err.message}).`);
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`Refusing to connect: test MongoDB host "${host}" is not loopback. Financial tests only run against disposable local databases.`);
  }
}

function randomDbName() {
  return `eatswada_fin_test_${crypto.randomBytes(6).toString('hex')}`;
}

function describeError(err) {
  if (!err) return 'unknown error';
  return err.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : String(err.message || err);
}

// ── lifecycle ─────────────────────────────────────────────────────────────

async function stopActive() {
  if (stopPromise) return stopPromise;
  stopPromise = (async () => {
    const server = activeServer;
    activeServer = null;
    activeKind = null;
    startPromise = null;

    let mongoose = null;
    try { mongoose = require('mongoose'); } catch (_) { /* not installed */ }

    if (mongoose) {
      try {
        await withTimeout(mongoose.disconnect(), STOP_TIMEOUT_MS, 'mongoose.disconnect');
      } catch (err) {
        console.error(`[test-harness] WARNING: mongoose.disconnect failed: ${err.message}`);
      }
    }
    if (server) {
      try {
        await withTimeout(server.stop({ doCleanup: true, force: true }), STOP_TIMEOUT_MS, 'mongod stop');
      } catch (err) {
        console.error(`[test-harness] WARNING: could not stop the in-memory MongoDB cleanly: ${err.message}`);
      }
    }
  })().finally(() => { stopPromise = null; });
  return stopPromise;
}

function installProcessGuards() {
  if (handlersInstalled) return;
  handlersInstalled = true;

  const die = (label, err, code) => {
    console.error(`\n[test-harness] ${label}: ${describeError(err)}`);
    // Best effort teardown, then force exit so a wedged driver can never hang CI.
    const hardExit = setTimeout(() => process.exit(code), STOP_TIMEOUT_MS + 2000);
    hardExit.unref();
    stopActive().finally(() => process.exit(code));
  };

  process.on('SIGINT', () => die('SIGINT received', null, 130));
  process.on('SIGTERM', () => die('SIGTERM received', null, 143));
  process.on('uncaughtException', (err) => die('uncaughtException', err, 1));
  process.on('unhandledRejection', (err) => die('unhandledRejection', err, 1));

  // Whole-suite watchdog. unref() so it never keeps a finished process alive.
  watchdog = setTimeout(() => die(`suite exceeded ${SUITE_TIMEOUT_MS} ms`, null, 1), SUITE_TIMEOUT_MS);
  watchdog.unref();
}

async function initAllModels(mongoose) {
  // Build indexes (unique indexes carry the idempotency guarantees under test)
  // and create collections before any test runs. Failures are NOT swallowed: a
  // missing unique index would make the concurrency tests meaningless.
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
}

async function describeTopology(mongoose) {
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  return { replicaSetName: hello.setName || null, writablePrimary: hello.isWritablePrimary === true };
}

async function probeTransaction(mongoose) {
  // Proves the deployment can really commit a multi-document transaction.
  // Only a real replica set may pass this.
  const name = 'harness_txn_probe';
  await mongoose.connection.db.collection(name).insertOne({ seed: true });
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await mongoose.connection.db.collection(name).insertOne({ inTxn: true }, { session });
    });
  } finally {
    await session.endSession();
  }
  const count = await mongoose.connection.db.collection(name).countDocuments({});
  if (count !== 2) throw new Error(`transaction probe expected 2 documents, found ${count}`);
}

async function boot(kind) {
  installProcessGuards();

  const mongoose = require('mongoose');
  const mms = require('mongodb-memory-server');

  let server;
  const creating = kind === 'replset'
    ? mms.MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
    : mms.MongoMemoryServer.create();

  try {
    server = await withTimeout(creating, START_TIMEOUT_MS, `start in-memory ${kind}`);
  } catch (err) {
    // If create() finishes after we gave up, stop that orphan instead of leaking it.
    creating.then((late) => late && late.stop({ doCleanup: true, force: true }).catch(() => {}), () => {});
    throw new Error(`Could not start the in-memory MongoDB ${kind}: ${err.message}. ` +
      'This is a test-environment problem (missing/unsupported mongod binary, no network for the first download, or unsupported platform), not a financial-logic failure.');
  }

  activeServer = server;
  activeKind = kind;

  try {
    const uri = server.getUri();
    assertLoopbackUri(uri);
    await withTimeout(
      mongoose.connect(uri, { dbName: randomDbName(), serverSelectionTimeoutMS: 30000 }),
      START_TIMEOUT_MS,
      'mongoose.connect'
    );
    await withTimeout(initAllModels(mongoose), START_TIMEOUT_MS, 'model init (indexes)');

    const topo = await describeTopology(mongoose);
    if (kind === 'replset') {
      if (!topo.replicaSetName || !topo.writablePrimary) {
        throw new Error(`expected a writable replica-set primary, got ${JSON.stringify(topo)}`);
      }
      await withTimeout(probeTransaction(mongoose), 30000, 'transaction probe');
    } else if (topo.replicaSetName) {
      throw new Error(`expected a STANDALONE mongod but connected to replica set "${topo.replicaSetName}"`);
    }
  } catch (err) {
    await stopActive();
    throw err;
  }
  return mongoose;
}

/** Start a disposable single-node replica set and connect mongoose to it. */
async function startReplSet() {
  if (!startPromise) {
    startPromise = boot('replset');
    startPromise.catch(() => { startPromise = null; }); // allow a clean retry after a failed start
  }
  return startPromise;
}

/** Stop the replica set started by startReplSet(). Safe to call repeatedly. */
async function stopReplSet() {
  return stopActive();
}

/** Start a disposable STANDALONE mongod (no transactions) and connect mongoose. */
async function startStandalone() {
  if (!startPromise) {
    startPromise = boot('standalone');
    startPromise.catch(() => { startPromise = null; }); // allow a clean retry after a failed start
  }
  return startPromise;
}

/** Stop the standalone mongod started by startStandalone(). Safe to call repeatedly. */
async function stopStandalone() {
  return stopActive();
}

// ── Express request / response doubles ────────────────────────────────────

/**
 * Minimal Express-like request. Pass user / params / body / query / headers as
 * needed; anything else is copied over verbatim.
 */
function makeReq(overrides = {}) {
  const headers = {};
  for (const [k, v] of Object.entries(overrides.headers || {})) headers[String(k).toLowerCase()] = v;
  const req = {
    user: undefined,
    params: {},
    body: {},
    query: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
    headers,
  };
  req.get = req.header = (name) => headers[String(name).toLowerCase()];
  return req;
}

/**
 * Minimal Express-like response. `statusCode` stays null until the handler
 * actually responds (status()/json()/send()/end()), so a handler that never
 * answers cannot be mistaken for a 200.
 */
function makeRes() {
  const res = {
    statusCode: null,
    body: undefined,
    headers: {},
    sent: false,
    status(code) { this.statusCode = code; return this; },
    sendStatus(code) { this.statusCode = code; this.sent = true; return this; },
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    setHeader(name, value) { return this.set(name, value); },
    header(name, value) { return this.set(name, value); },
    type() { return this; },
    cookie() { return this; },
    clearCookie() { return this; },
    json(payload) {
      if (this.statusCode == null) this.statusCode = 200;
      this.body = payload;
      this.sent = true;
      return this;
    },
    send(payload) {
      if (this.statusCode == null) this.statusCode = 200;
      this.body = payload;
      this.sent = true;
      return this;
    },
    end(payload) {
      if (this.statusCode == null) this.statusCode = 200;
      if (payload !== undefined) this.body = payload;
      this.sent = true;
      return this;
    },
  };
  return res;
}

// ── Reporter ──────────────────────────────────────────────────────────────

/**
 * const { test, finish } = makeReporter('Suite name');
 * await test('name', async () => { ...assertions... });
 * const code = finish();   // 0 = all passed (and at least one ran), 1 otherwise
 */
function makeReporter(suiteName) {
  const results = [];
  const seen = new Set();
  console.log(`\n=== ${suiteName} ===`);

  async function test(name, fn) {
    if (seen.has(name)) console.warn(`  ! duplicate test name: "${name}"`);
    seen.add(name);
    const started = Date.now();
    try {
      await withTimeout(Promise.resolve().then(fn), TEST_TIMEOUT_MS, `test "${name}"`);
      results.push({ name, ok: true });
      console.log(`  PASS  ${name} (${Date.now() - started} ms)`);
    } catch (err) {
      results.push({ name, ok: false, err });
      console.log(`  FAIL  ${name} (${Date.now() - started} ms)`);
      console.log(String(describeError(err)).split('\n').map((l) => `        ${l}`).join('\n'));
    }
  }

  function finish() {
    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    console.log(`\n${suiteName}: ${passed} passed, ${failed} failed (${results.length} total)`);
    if (failed) {
      console.log('Failed tests:');
      results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}`));
      return 1;
    }
    if (results.length === 0) {
      console.log('No tests were executed - treating this as a failure.');
      return 1;
    }
    return 0;
  }

  return { test, finish };
}

module.exports = {
  startReplSet,
  stopReplSet,
  startStandalone,
  stopStandalone,
  makeReq,
  makeRes,
  makeReporter,
};

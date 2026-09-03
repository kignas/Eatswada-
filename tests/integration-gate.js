#!/usr/bin/env node
'use strict';

// Phase 3.2 integration gate.
// Safe by default: only performs GET/login/authorization checks.
// Mutation tests require TEST_ALLOW_MUTATIONS=true and a dedicated TEST_* environment.

const assert = require('assert');

const BASE = (process.env.TEST_BASE_URL || '').replace(/\/$/, '');
const results = [];

function pass(name){ results.push(['PASS', name]); }
function fail(name, err){ results.push(['FAIL', name, err.message || String(err)]); }
async function check(name, fn){
  try { await fn(); pass(name); } catch (e) { fail(name, e); }
}

async function request(path, options = {}) {
  if (!BASE) throw new Error('TEST_BASE_URL is required, e.g. http://localhost:5000');
  const res = await fetch(BASE + path, {
    redirect: 'manual',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { res, body };
}

function auth(token){ return token ? { Authorization: `Bearer ${token}` } : {}; }
function requireEnv(name){
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

(async () => {
  if (!BASE) {
    console.error('ERROR: set TEST_BASE_URL before running integration-gate.');
    process.exit(2);
  }

  await check('API responds to GET /api/health', async () => {
    const {res} = await request('/health');
    assert(res.status < 500, `HTTP ${res.status}`);
  });

  await check('Public restaurant endpoint responds with JSON', async () => {
    const {res, body} = await request('/api/restaurants?limit=1');
    assert(res.status < 500, `HTTP ${res.status}`);
    assert(body !== null, 'empty/non-JSON response');
  });

  await check('Public category endpoint responds', async () => {
    const {res} = await request('/api/categories');
    assert(res.status < 500, `HTTP ${res.status}`);
  });

  // Authorization boundary checks require no credentials and are safe.
  for (const [name, path] of [
    ['Admin metrics rejects anonymous access', '/api/admin/metrics'],
    ['Vendor orders rejects anonymous access', '/api/vendor/orders'],
    ['Rider orders rejects anonymous access', '/api/rider/orders'],
    ['Customer orders rejects anonymous access', '/api/orders']
  ]) {
    await check(name, async () => {
      const {res} = await request(path);
      assert([401,403].includes(res.status), `expected 401/403, got ${res.status}`);
    });
  }

  const tokens = {
    admin: process.env.TEST_ADMIN_TOKEN,
    vendor: process.env.TEST_VENDOR_TOKEN,
    rider: process.env.TEST_RIDER_TOKEN,
    customer: process.env.TEST_CUSTOMER_TOKEN
  };

  if (tokens.admin) {
    await check('Admin token can access admin metrics', async () => {
      const {res} = await request('/api/admin/metrics', {headers: auth(tokens.admin)});
      assert(res.status < 400, `HTTP ${res.status}`);
    });
    await check('Admin token cannot be used as vendor token', async () => {
      const {res} = await request('/api/vendor/orders', {headers: auth(tokens.admin)});
      assert([401,403].includes(res.status), `expected 401/403, got ${res.status}`);
    });
  }

  if (tokens.vendor) {
    await check('Vendor token can access vendor restaurant', async () => {
      const {res} = await request('/api/vendor/restaurant', {headers: auth(tokens.vendor)});
      assert(res.status < 400, `HTTP ${res.status}`);
    });
    await check('Vendor token cannot access admin metrics', async () => {
      const {res} = await request('/api/admin/metrics', {headers: auth(tokens.vendor)});
      assert([401,403].includes(res.status), `expected 401/403, got ${res.status}`);
    });
  }

  if (tokens.rider) {
    await check('Rider token can access rider profile', async () => {
      const {res} = await request('/api/rider/profile', {headers: auth(tokens.rider)});
      assert(res.status < 400, `HTTP ${res.status}`);
    });
    await check('Rider token cannot access admin metrics', async () => {
      const {res} = await request('/api/admin/metrics', {headers: auth(tokens.rider)});
      assert([401,403].includes(res.status), `expected 401/403, got ${res.status}`);
    });
  }

  if (tokens.customer) {
    await check('Customer token can access profile', async () => {
      const {res} = await request('/api/users/profile', {headers: auth(tokens.customer)});
      assert(res.status < 400, `HTTP ${res.status}`);
    });
    await check('Customer token cannot access admin metrics', async () => {
      const {res} = await request('/api/admin/metrics', {headers: auth(tokens.customer)});
      assert([401,403].includes(res.status), `expected 401/403, got ${res.status}`);
    });
  }

  // Optional mutation/lifecycle hook. Keep disabled unless explicitly requested.
  if (process.env.TEST_ALLOW_MUTATIONS === 'true') {
    await check('Mutation gate requires explicit test marker', async () => {
      assert(process.env.TEST_DB_NAME || process.env.TEST_CONFIRM_MUTATIONS === 'EATSWADA_TEST_DB',
        'Set TEST_DB_NAME or TEST_CONFIRM_MUTATIONS=EATSWADA_TEST_DB before enabling mutations');
    });
    console.log('NOTE: full order lifecycle mutation tests are intentionally not embedded here because endpoint payloads/fixture IDs must match the deployed test database.');
  }

  let failed = 0;
  for (const [status, name, message] of results) {
    console.log(`${status} ${name}${message ? ` — ${message}` : ''}`);
    if (status === 'FAIL') failed++;
  }
  console.log(`Integration-gate: ${results.length - failed} passed, ${failed} failed`);
  console.log(`Base URL: ${BASE}`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(`FATAL integration-gate error: ${err.message}`);
  process.exit(2);
});

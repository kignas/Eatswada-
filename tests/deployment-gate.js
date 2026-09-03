/**
 * Eatswada Phase 3.4 deployment gate.
 *
 * Safe by default: GET-only checks against a deployed backend.
 * Set EATSWADA_API_BASE_URL to the deployed API root, e.g.
 * https://example.onrender.com/api
 *
 * Optional CORS check:
 *   EATSWADA_ORIGIN=https://your-customer-domain.example
 */
const assert = require('assert');

const base = (process.env.EATSWADA_API_BASE_URL || '').replace(/\/$/, '');
const origin = process.env.EATSWADA_ORIGIN || '';

if (!base) {
  console.log('Deployment gate: SKIPPED (set EATSWADA_API_BASE_URL to run live GET checks)');
  process.exit(0);
}

async function get(path, headers = {}) {
  const res = await fetch(`${base}${path}`, { headers, redirect: 'manual' });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) {}
  return { res, text, body };
}

(async () => {
  let passed = 0;
  let failed = 0;
  const check = (name, fn) => Promise.resolve().then(fn).then(() => {
    passed++; console.log(`PASS ${name}`);
  }).catch(err => {
    failed++; console.error(`FAIL ${name}: ${err.message}`);
  });

  // Backend health is mounted outside /api in server.js.
  const apiOrigin = new URL(base).origin;
  await check('Production backend health', async () => {
    const r = await fetch(`${apiOrigin}/health`, { redirect: 'manual' });
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
  });

  await check('Public restaurants endpoint responds', async () => {
    const r = await get('/restaurants');
    assert.ok([200, 304].includes(r.res.status), `expected 200/304, got ${r.res.status}`);
  });

  await check('Protected users profile rejects anonymous access', async () => {
    const r = await get('/users/profile');
    assert.ok([401, 403].includes(r.res.status), `expected 401/403, got ${r.res.status}`);
  });

  if (origin) {
    await check('CORS allows configured customer origin', async () => {
      const r = await fetch(`${apiOrigin}/health`, {
        headers: { Origin: origin },
      });
      const allow = r.headers.get('access-control-allow-origin');
      assert.strictEqual(allow, origin, `expected ACAO ${origin}, got ${allow}`);
    });
  } else {
    console.log('SKIP CORS customer-origin check (set EATSWADA_ORIGIN)');
  }

  console.log(`Deployment gate: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch(err => {
  console.error(`Deployment gate crashed: ${err.stack || err}`);
  process.exitCode = 1;
});

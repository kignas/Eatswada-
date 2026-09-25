#!/usr/bin/env node
/**
 * Eatswada "lunch rush" load test — no npm packages needed (Node 18+).
 *
 * Simulates N customers using the app at the same time:
 *   home (serviceability, restaurants, banners, categories, ₹99 store)
 *   → open 1–2 restaurants (details, menu, reviews) → search a dish
 *   → logged-in users: profile, cart, add an item to cart, notifications
 *   → ~40% of logged-in users then sit on the tracking screen polling their orders
 *
 * It never places orders or touches Razorpay. Cart writes only affect the
 * test customers created by prepare-staging.js.
 *
 * Usage:
 *   BASE_URL=https://your-staging.onrender.com node loadtest/lunch-rush.js
 *
 * Env:
 *   BASE_URL            required — your STAGING backend (not production)
 *   USERS=50            simultaneous customers
 *   DURATION_SEC=300    test length after ramp-up
 *   RAMP_SEC=60         time to bring all users online
 *   TOKENS_FILE=loadtest/tokens.json   customer JWTs (from prepare-staging.js); without it users browse as guests
 *   TRACK_INTERVAL_SEC=10              how often the tracking screen polls
 *   LAT=26.56 LNG=88.82                customer location for serviceability
 *   P95_TARGET_MS=800   pass/fail threshold
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE_URL = String(process.env.BASE_URL || '').replace(/\/+$/, '');
const USERS = Number(process.env.USERS) || 50;
const DURATION_SEC = Number(process.env.DURATION_SEC) || 300;
const RAMP_SEC = Number(process.env.RAMP_SEC) || 60;
const TRACK_INTERVAL_SEC = Number(process.env.TRACK_INTERVAL_SEC) || 10;
const LAT = Number(process.env.LAT) || 26.56;
const LNG = Number(process.env.LNG) || 88.82;
const P95_TARGET_MS = Number(process.env.P95_TARGET_MS) || 800;
const TIMEOUT_MS = 15000;
const TOKENS_FILE = process.env.TOKENS_FILE || path.join(__dirname, 'tokens.json');

if (!BASE_URL) {
  console.error('Set BASE_URL to your STAGING backend, e.g. BASE_URL=https://eatswada-staging.onrender.com');
  process.exit(1);
}
if (typeof fetch !== 'function') {
  console.error('Node 18 or newer is required (built-in fetch).');
  process.exit(1);
}

let tokens = [];
try { tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch (_) { tokens = []; }

// ── Metrics ───────────────────────────────────────────────────
const stats = new Map(); // endpoint label -> { times: [], codes: {}, errors: 0, bytes: 0 }
let inFlight = 0;
let peakInFlight = 0;
const startedAt = Date.now();
let stopAt = Infinity;
const healthSamples = [];

function record(label, ms, code, bytes, isError) {
  if (!stats.has(label)) stats.set(label, { times: [], codes: {}, errors: 0, bytes: 0 });
  const s = stats.get(label);
  s.times.push(ms);
  s.codes[code] = (s.codes[code] || 0) + 1;
  s.bytes += bytes;
  if (isError) s.errors += 1;
}

async function call(label, method, urlPath, { token, body } = {}) {
  const headers = { Accept: 'application/json', 'Accept-Encoding': 'gzip' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const t0 = performance.now();
  inFlight++; peakInFlight = Math.max(peakInFlight, inFlight);
  try {
    const res = await fetch(BASE_URL + urlPath, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    const ms = performance.now() - t0;
    record(label, ms, res.status, text.length, res.status >= 500);
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, json };
  } catch (err) {
    const ms = performance.now() - t0;
    const code = err.name === 'TimeoutError' ? 'timeout' : 'network';
    record(label, ms, code, 0, true);
    return { status: 0, json: null };
  } finally {
    inFlight--;
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Pauses end early when the test is over, so the report covers the real window.
const pause = (ms) => sleep(Math.max(0, Math.min(ms, stopAt - Date.now())));
const think = (minS, maxS) => pause((minS + Math.random() * (maxS - minS)) * 1000);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const running = () => Date.now() < stopAt;

// ── One simulated customer ────────────────────────────────────
async function customer(id) {
  const token = tokens.length ? tokens[id % tokens.length] : null;
  const willTrack = token && Math.random() < 0.4;
  let trackedOnce = false;

  while (running()) {
    // Home screen (the frontend fires these together)
    const [, list] = await Promise.all([
      call('GET /restaurants/serviceability', 'GET', `/api/restaurants/serviceability?lat=${LAT}&lng=${LNG}`),
      call('GET /restaurants (home list)', 'GET', '/api/restaurants?page=1&limit=20'),
      call('GET /home-banners', 'GET', '/api/home-banners'),
      call('GET /categories', 'GET', '/api/categories'),
      call('GET /restaurants/under99', 'GET', '/api/restaurants/under99'),
    ]);
    if (!running()) break;
    await think(3, 8);

    const restaurants = Array.isArray(list.json?.data) ? list.json.data : [];
    const menuItems = [];
    const visits = restaurants.length ? 1 + Math.floor(Math.random() * 2) : 0;
    for (let v = 0; v < visits && running(); v++) {
      const r = pick(restaurants);
      const [, menu] = await Promise.all([
        call('GET /restaurants/:id', 'GET', `/api/restaurants/${r._id}`),
        call('GET /restaurants/:id/menu', 'GET', `/api/restaurants/${r._id}/menu`),
        call('GET /restaurants/:id/reviews', 'GET', `/api/restaurants/${r._id}/reviews`),
      ]);
      const grouped = menu.json?.data && typeof menu.json.data === 'object' ? menu.json.data : {};
      for (const items of Object.values(grouped)) {
        if (Array.isArray(items)) menuItems.push(...items);
      }
      await think(4, 10);
    }
    if (!running()) break;

    // Search a dish the customer just saw
    const word = (pick(menuItems.length ? menuItems : [{ name: 'chicken' }]).name || 'chicken')
      .replace(/^\[LT\]\s*/, '').split(/\s+/)[0].slice(0, 20) || 'chicken';
    if (word.length >= 2) {
      await call('GET /restaurants/search', 'GET', `/api/restaurants/search?q=${encodeURIComponent(word)}&scope=home`);
      await think(2, 5);
    }

    if (token && running()) {
      await Promise.all([
        call('GET /users/profile', 'GET', '/api/users/profile', { token }),
        call('GET /cart', 'GET', '/api/cart', { token }),
        call('GET /notifications', 'GET', '/api/notifications', { token }),
      ]);
      const addable = menuItems.filter(i => i && i._id && i.inStock !== false &&
        !(Array.isArray(i.customizations) && i.customizations.some(c => c && c.required)));
      if (addable.length) {
        await call('POST /cart/add', 'POST', '/api/cart/add', { token, body: { menuItemId: pick(addable)._id, quantity: 1 } });
      }
      await think(3, 6);

      // Waiting-for-food: sit on the tracking screen for 2–4 minutes
      if (willTrack && !trackedOnce && running()) {
        trackedOnce = true;
        const until = Date.now() + (120 + Math.random() * 120) * 1000;
        while (running() && Date.now() < until) {
          await call('GET /orders (tracking poll)', 'GET', '/api/orders?page=1&limit=10', { token });
          await pause(TRACK_INTERVAL_SEC * 1000);
        }
      }
    }
    await think(5, 15);
  }
}

// ── Health sampler (does the server stay up?) ─────────────────
async function healthLoop() {
  while (running()) {
    const t0 = performance.now();
    try {
      const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      healthSamples.push({ ok: res.ok, ms: performance.now() - t0 });
    } catch (_) {
      healthSamples.push({ ok: false, ms: performance.now() - t0 });
    }
    await pause(5000);
  }
}

// ── Report ────────────────────────────────────────────────────
function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
function pad(s, n, right) { s = String(s); return right ? s.padStart(n) : s.padEnd(n); }

function report() {
  const elapsed = (Date.now() - startedAt) / 1000;
  const all = [];
  let total = 0, errors = 0, r429 = 0, r4xx = 0;
  console.log('\n' + '═'.repeat(104));
  console.log(pad('Endpoint', 34) + pad('reqs', 7, 1) + pad('p50', 8, 1) + pad('p95', 8, 1) + pad('p99', 8, 1) + pad('max', 8, 1) + pad('5xx/err', 9, 1) + pad('avg KB', 9, 1) + '  status codes');
  console.log('─'.repeat(104));
  const rows = [...stats.entries()].sort((a, b) => pct([...b[1].times].sort((x, y) => x - y), 95) - pct([...a[1].times].sort((x, y) => x - y), 95));
  for (const [label, s] of rows) {
    const t = [...s.times].sort((a, b) => a - b);
    all.push(...t);
    total += t.length; errors += s.errors;
    r429 += s.codes[429] || 0;
    for (const [c, n] of Object.entries(s.codes)) if (/^4\d\d$/.test(c) && c !== '429') r4xx += n;
    const codes = Object.entries(s.codes).map(([c, n]) => `${c}:${n}`).join(' ');
    console.log(
      pad(label, 34) + pad(t.length, 7, 1) +
      pad(Math.round(pct(t, 50)), 8, 1) + pad(Math.round(pct(t, 95)), 8, 1) +
      pad(Math.round(pct(t, 99)), 8, 1) + pad(Math.round(t[t.length - 1] || 0), 8, 1) +
      pad(s.errors, 9, 1) + pad((s.bytes / Math.max(1, t.length) / 1024).toFixed(1), 9, 1) + '  ' + codes
    );
  }
  all.sort((a, b) => a - b);
  const p95 = pct(all, 95);
  const errRate = total ? (errors / total) * 100 : 0;
  const healthFails = healthSamples.filter(h => !h.ok).length;
  console.log('─'.repeat(104));
  console.log(`Users: ${USERS} (${tokens.length ? `${tokens.length} logged-in tokens` : 'guests only — run prepare-staging.js for logged-in users'})`);
  console.log(`Duration: ${elapsed.toFixed(0)}s   Requests: ${total}   Throughput: ${(total / elapsed).toFixed(1)} req/s   Peak concurrent requests: ${peakInFlight}`);
  console.log(`Overall p50 ${Math.round(pct(all, 50))} ms · p95 ${Math.round(p95)} ms · p99 ${Math.round(pct(all, 99))} ms`);
  console.log(`Errors (5xx/timeouts/network): ${errors} (${errRate.toFixed(2)}%)   429 rate-limited: ${r429}   other 4xx: ${r4xx}`);
  console.log(`/health checks failed: ${healthFails}/${healthSamples.length}`);
  console.log('═'.repeat(104));

  const checks = [
    [`p95 latency ≤ ${P95_TARGET_MS} ms`, p95 <= P95_TARGET_MS],
    ['error rate < 1%', errRate < 1],
    ['no rate limiting (429)', r429 === 0],
    ['server stayed healthy', healthFails === 0],
  ];
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (r429) {
    console.log('\n429s mean the test was blocked by your IP rate limiter, so latency numbers are not meaningful.');
    console.log('On the STAGING service set RATE_LIMIT_MAX=100000, redeploy, and run again.');
  }
  if (r4xx) console.log('\nOther 4xx are usually normal business answers (closed restaurant, out-of-stock item). Check the status codes column.');
  process.exitCode = checks.every(c => c[1]) ? 0 : 1;
}

// ── Run ───────────────────────────────────────────────────────
(async () => {
  console.log(`Eatswada lunch-rush load test → ${BASE_URL}`);
  console.log(`${USERS} users, ramp ${RAMP_SEC}s, then ${DURATION_SEC}s steady. Tracking poll every ${TRACK_INTERVAL_SEC}s.`);
  const warm = await call('warm-up /health', 'GET', '/health');
  if (warm.status !== 200) {
    console.error(`Backend not healthy at ${BASE_URL}/health (status ${warm.status}). Aborting.`);
    process.exit(1);
  }
  stats.clear();
  stopAt = Date.now() + (RAMP_SEC + DURATION_SEC) * 1000;

  const progress = setInterval(() => {
    let n = 0, e = 0;
    for (const s of stats.values()) { n += s.times.length; e += s.errors; }
    const secs = Math.round((Date.now() - startedAt) / 1000);
    process.stdout.write(`\r  ${secs}s  requests: ${n}  errors: ${e}  in-flight: ${inFlight}   `);
  }, 2000);

  const workers = [healthLoop()];
  for (let i = 0; i < USERS; i++) {
    workers.push(sleep((RAMP_SEC * 1000 * i) / USERS).then(() => customer(i)));
  }
  process.on('SIGINT', () => { stopAt = 0; });
  await Promise.all(workers);
  clearInterval(progress);
  report();
})();

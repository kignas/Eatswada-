'use strict';

/**
 * Opt-in performance diagnostics — OFF unless PERF_DIAGNOSTICS=true.
 *
 * Purpose: during a load test, tell apart the possible shared bottlenecks
 * behind slow requests, using only Node built-ins and MongoDB driver events
 * (no dependency, no external service):
 *
 *   routes      server-side time per route (inside Node, request → response)
 *   eventLoopMs event-loop delay — high = CPU busy / blocked JavaScript
 *   cpu         process CPU as % of ONE core + the container CPU limit and
 *               how often the container was throttled (Linux cgroup files)
 *   db          MongoDB command durations as measured by the driver (network
 *               round trip + server time), connection-pool wait, and how many
 *               new DB connections were opened (each costs several round trips)
 *
 * Every PERF_DIAGNOSTICS_INTERVAL_MS (default 15000, min 5000) it writes ONE
 * line to stdout:  [PERF] {...json...}   (only when there was activity).
 * When disabled nothing is mounted, no timer runs and no driver option changes.
 */

const fs = require('fs');
const { monitorEventLoopDelay } = require('perf_hooks');

const enabled = String(process.env.PERF_DIAGNOSTICS || '').trim().toLowerCase() === 'true';
const INTERVAL_MS = Math.max(5000, Number(process.env.PERF_DIAGNOSTICS_INTERVAL_MS) || 15000);

// Driver-internal / auth commands are not application queries.
const IGNORED_COMMANDS = new Set(['hello', 'ismaster', 'isMaster', 'ping', 'saslStart', 'saslContinue', 'authenticate', 'endSessions', 'buildInfo', 'getnonce']);

let current = freshWindow();
let inFlight = 0;
let loopDelay = null;
let timer = null;
let lastCpu = process.cpuUsage();        // baseline; start() resets it
let lastWall = process.hrtime.bigint();
let lastCgroup = null;
let cpuLimitCores = null;

function freshWindow() {
  return {
    routes: new Map(),       // "GET /api/cart" -> [ms]
    maxInFlight: 0,
    dbByCommand: new Map(),  // "find" -> [ms]
    dbFailed: 0,
    poolWaitMs: [],
    poolCheckoutFailed: 0,
    connectionsCreated: 0,
    connectionReadyMs: [],
  };
}

function round(n) { return Math.round(n * 10) / 10; }

function summarize(values) {
  if (!values.length) return { n: 0 };
  const s = values.slice().sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
  return { n: s.length, p50: round(at(50)), p95: round(at(95)), max: round(s[s.length - 1]) };
}

function push(map, key, value) {
  let list = map.get(key);
  if (!list) { list = []; map.set(key, list); }
  list.push(value);
}

// "/api/v1/restaurants/65f1…3b/menu?x=1" -> "/api/restaurants/:id/menu"
function routeLabel(req) {
  const path = String(req.originalUrl || req.url || '').split('?')[0]
    .replace(/^\/api\/v1(?=\/|$)/, '/api')
    .replace(/\/[0-9a-fA-F]{24}(?=\/|$)/g, '/:id');
  return `${req.method} ${path}`;
}

function middleware(req, res, next) {
  const start = process.hrtime.bigint();
  inFlight += 1;
  if (inFlight > current.maxInFlight) current.maxInFlight = inFlight;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    inFlight -= 1;
    try {
      push(current.routes, routeLabel(req), Number(process.hrtime.bigint() - start) / 1e6);
    } catch (_) { /* diagnostics must never affect a request */ }
  };
  res.on('finish', finish);
  res.on('close', finish);
  next();
}

function readFirst(paths) {
  for (const p of paths) {
    try { return fs.readFileSync(p, 'utf8'); } catch (_) { /* try next */ }
  }
  return null;
}

// Linux cgroup v2 (/sys/fs/cgroup/cpu.stat) or v1 (cpu,cpuacct/cpu.stat).
function readCgroupCpuStat() {
  const text = readFirst(['/sys/fs/cgroup/cpu.stat', '/sys/fs/cgroup/cpu,cpuacct/cpu.stat', '/sys/fs/cgroup/cpu/cpu.stat']);
  if (!text) return null;
  const v = {};
  for (const line of text.split('\n')) {
    const [k, n] = line.trim().split(/\s+/);
    if (k) v[k] = Number(n);
  }
  if (!Number.isFinite(v.nr_periods)) return null;
  const throttledMs = Number.isFinite(v.throttled_usec) ? v.throttled_usec / 1000
    : Number.isFinite(v.throttled_time) ? v.throttled_time / 1e6 : 0;
  return { periods: v.nr_periods, throttled: v.nr_throttled || 0, throttledMs };
}

function readCpuLimitCores() {
  const v2 = readFirst(['/sys/fs/cgroup/cpu.max']);
  if (v2) {
    const [quota, period] = v2.trim().split(/\s+/);
    if (quota === 'max') return 'unlimited';
    if (Number(quota) > 0 && Number(period) > 0) return round(Number(quota) / Number(period) * 100) / 100;
  }
  const quota = Number(readFirst(['/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us', '/sys/fs/cgroup/cpu/cpu.cfs_quota_us']));
  const period = Number(readFirst(['/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us', '/sys/fs/cgroup/cpu/cpu.cfs_period_us']));
  if (quota > 0 && period > 0) return round(quota / period * 100) / 100;
  if (quota === -1) return 'unlimited';
  return null;
}

function attachMongo(connection) {
  let client = null;
  try { client = connection && typeof connection.getClient === 'function' ? connection.getClient() : null; } catch (_) { client = null; }
  if (!client || typeof client.on !== 'function') return false;

  const onCommand = (event, failed) => {
    try {
      if (!event || IGNORED_COMMANDS.has(event.commandName)) return;
      if (failed) current.dbFailed += 1;
      if (typeof event.duration === 'number') push(current.dbByCommand, event.commandName, event.duration);
    } catch (_) { /* ignore */ }
  };
  client.on('commandSucceeded', (e) => onCommand(e, false));
  client.on('commandFailed', (e) => onCommand(e, true));
  client.on('connectionCreated', () => { current.connectionsCreated += 1; });
  client.on('connectionReady', (e) => { if (e && typeof e.durationMS === 'number') current.connectionReadyMs.push(e.durationMS); });
  client.on('connectionCheckedOut', (e) => { if (e && typeof e.durationMS === 'number') current.poolWaitMs.push(e.durationMS); });
  client.on('connectionCheckOutFailed', () => { current.poolCheckoutFailed += 1; });
  return true;
}

function report() {
  const w = current;
  current = freshWindow();

  const nowCpu = process.cpuUsage();
  const nowWall = process.hrtime.bigint();
  const cpuMicros = (nowCpu.user - lastCpu.user) + (nowCpu.system - lastCpu.system);
  const wallMicros = Number(nowWall - lastWall) / 1000;
  lastCpu = nowCpu;
  lastWall = nowWall;

  const cg = readCgroupCpuStat();
  let throttling = null;
  if (cg && lastCgroup) {
    const periods = cg.periods - lastCgroup.periods;
    throttling = {
      throttledPeriodsPct: periods > 0 ? round(((cg.throttled - lastCgroup.throttled) / periods) * 100) : 0,
      throttledMs: round(cg.throttledMs - lastCgroup.throttledMs),
    };
  }
  lastCgroup = cg;

  let requests = 0;
  const routes = {};
  for (const [label, list] of [...w.routes.entries()].sort((a, b) => b[1].length - a[1].length)) {
    requests += list.length;
    routes[label] = summarize(list);
  }
  let dbCommands = 0;
  const byCommand = {};
  for (const [name, list] of w.dbByCommand) {
    dbCommands += list.length;
    byCommand[name] = summarize(list);
  }

  if (!requests && !dbCommands) {
    if (loopDelay) loopDelay.reset();
    return null; // idle window: stay quiet
  }

  const mem = process.memoryUsage();
  const line = {
    t: new Date().toISOString(),
    windowSec: round(wallMicros / 1e6),
    requests,
    maxInFlight: w.maxInFlight,
    eventLoopMs: loopDelay ? {
      p50: round(loopDelay.percentile(50) / 1e6),
      p99: round(loopDelay.percentile(99) / 1e6),
      max: round(loopDelay.max / 1e6),
    } : null,
    cpu: {
      processPctOfOneCore: wallMicros > 0 ? round((cpuMicros / wallMicros) * 100) : 0,
      containerLimitCores: cpuLimitCores,
      throttling,
    },
    memMB: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
    db: {
      commands: dbCommands,
      failed: w.dbFailed,
      byCommand,
      poolWaitMs: summarize(w.poolWaitMs),
      poolCheckoutFailed: w.poolCheckoutFailed,
      connectionsCreated: w.connectionsCreated,
      connectionReadyMs: summarize(w.connectionReadyMs),
    },
    routes,
  };
  if (loopDelay) loopDelay.reset();
  console.log(`[PERF] ${JSON.stringify(line)}`);
  return line;
}

function start(connection) {
  if (timer) return;
  attachMongo(connection);
  try {
    loopDelay = monitorEventLoopDelay({ resolution: 10 });
    loopDelay.enable();
  } catch (_) {
    loopDelay = null;
  }
  cpuLimitCores = readCpuLimitCores();
  lastCgroup = readCgroupCpuStat();
  lastCpu = process.cpuUsage();
  lastWall = process.hrtime.bigint();
  timer = setInterval(() => { try { report(); } catch (_) { /* never crash */ } }, INTERVAL_MS);
  if (timer.unref) timer.unref();
  console.log(`[PERF] diagnostics enabled: one [PERF] line every ${INTERVAL_MS / 1000}s while there is traffic (container CPU limit: ${cpuLimitCores ?? 'unknown'})`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  if (loopDelay) { try { loopDelay.disable(); } catch (_) { /* ignore */ } }
  loopDelay = null;
}

module.exports = { enabled, middleware, start, stop, report, attachMongo, routeLabel };

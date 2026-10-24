// Regression test: the customer phone-OTP endpoints are gone.
// The customer app has no phone-OTP login or sign-up (Google sign-in + email/password only) and no
// staff app uses OTP either, so POST /api/users/send-otp, /verify-otp and the OTP-based /register
// were dead code that only added risk: a 4-digit SMS code could be brute-forced (5 tries per
// 15-minute lock, per account) and anyone could burn SMS credits. They now behave like any unknown
// route (404 from the notFound handler). Email forgot-password OTP (6-digit, hashed) and the
// rider's delivery-OTP route are untouched.
// Runs with no database and no installed packages. Usage: npm run test:phone-otp-disabled
const Module = require('module');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ROUTES_FILE = path.join(ROOT, 'routes/userRoutes.js');
const CONTROLLER = path.join(ROOT, 'controllers/userController.js');

const anything = new Proxy(function () {}, { get: (t, p) => (p === 'then' ? undefined : anything), apply: () => anything, construct: () => anything });

// Load a module with every require stubbed (express.Router records the routes it is given).
function loadWith(file, stubs) {
  const origLoad = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (parent && parent.filename === file && request !== 'crypto') {
      const resolved = request.startsWith('.') ? path.resolve(path.dirname(file), request) + '.js' : request;
      return stubs[resolved] || stubs[request] || anything;
    }
    return origLoad.call(this, request, parent, ...rest);
  };
  try { return require(file); } finally { Module._load = origLoad; }
}

const routes = [];
const router = {};
for (const m of ['get', 'post', 'put', 'patch', 'delete', 'use']) {
  router[m] = (p) => { routes.push({ method: m, path: typeof p === 'string' ? p : null }); return router; };
}
loadWith(ROUTES_FILE, { express: { Router: () => router } });
const controller = loadWith(CONTROLLER, { 'express-async-handler': (fn) => fn });

let pass = 0;
const t = (name, fn) => {
  try { fn(); } catch (e) { console.error('FAIL', name, '-', e.message); process.exit(1); }
  pass++; console.log('PASS', name);
};
const has = (method, p) => routes.some(r => r.method === method && r.path === p);

t('A: no route is registered for /send-otp, /verify-otp or /register (any method)', () => {
  assert.ok(routes.length > 10, 'could not capture the user routes');
  for (const p of ['/send-otp', '/verify-otp', '/register']) {
    assert.ok(!routes.some(r => r.path === p), `${p} is still routed`);
  }
});

t('B: the rest of the customer API is still routed (login, logout, profile, addresses, email reset)', () => {
  for (const [m, p] of [['post', '/login'], ['post', '/logout'], ['get', '/profile'], ['put', '/profile'],
    ['get', '/addresses'], ['post', '/addresses'], ['put', '/addresses/:id'], ['delete', '/addresses/:id'],
    ['post', '/forgot-password/email'], ['post', '/forgot-password/email/verify'], ['post', '/forgot-password/email/reset']]) {
    assert.ok(has(m, p), `${m.toUpperCase()} ${p} is missing`);
  }
});

t('C: the controller no longer exports the OTP / register handlers; the others remain', () => {
  for (const name of ['sendOTPHandler', 'verifyOTPHandler', 'register']) {
    assert.strictEqual(controller[name], undefined, `${name} is still exported`);
  }
  for (const name of ['login', 'logout', 'getProfile', 'updateProfile', 'requestEmailPasswordReset', 'verifyEmailPasswordResetOTP', 'resetPasswordByEmailOTP']) {
    assert.strictEqual(typeof controller[name], 'function', `${name} is missing`);
  }
});

t('D: userController has no phone-OTP code left (no SMS sender, no checkOTP, no OTP issuing)', () => {
  const src = read('controllers/userController.js');
  for (const re of [/utils\/sendOTP/, /\bsendOTP\b/, /\bgenerateOTPCode\b/, /\bissueOTP\b/, /\.checkOTP\(/, /otpRequestedTooRecently/, /\+otp\./]) {
    assert.ok(!re.test(src), `userController still matches ${re}`);
  }
});

t('E: the SMS sender utils/sendOTP.js is deleted and nothing in the app requires it', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'utils/sendOTP.js')), 'utils/sendOTP.js still exists');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (['node_modules', 'tests', '.git'].includes(e.name)) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
  for (const f of walk(ROOT)) assert.ok(!/sendOTP/.test(fs.readFileSync(f, 'utf8')), `${path.relative(ROOT, f)} still references sendOTP`);
});

t('F: server.js has no /send-otp debug hook and still ends in the notFound handler after the user routes', () => {
  const server = read('server.js');
  assert.ok(!/send-otp/.test(server), 'server.js still mentions send-otp');
  const m = /\['\/users',\s*userRoutes\]/.exec(server);
  const users = m ? m.index : -1;
  const nfm = /^app\.use\(notFound\);/m.exec(server); // active line, not a comment
  const nf = nfm ? nfm.index : -1;
  assert.ok(users > -1 && nf > users, 'unknown /api/users/* paths no longer reach notFound (404)');
});

t('G: untouched — forgot-password email routes keep their rate limiters; rider delivery-OTP route remains', () => {
  const r = read('routes/userRoutes.js');
  assert.ok(/router\.post\('\/forgot-password\/email',\s*otpLimiter/.test(r), 'forgot-password lost otpLimiter');
  assert.ok(/router\.post\('\/forgot-password\/email\/verify',\s*loginLimiter/.test(r), 'forgot-password verify lost loginLimiter');
  assert.ok(/router\.post\('\/forgot-password\/email\/reset',\s*loginLimiter/.test(r), 'forgot-password reset lost loginLimiter');
  assert.ok(/router\.post\('\/orders\/:id\/verify-otp',\s*verifyDeliveryOtp\)/.test(read('routes/riderRoutes.js')), 'rider delivery OTP route changed');
});

console.log(`phone-otp-disabled: ${pass} scenarios passed`);

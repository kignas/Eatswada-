const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const checks = [
  ['Firebase Admin import points to models/firebaseAdmin', /require\(['"]\.\.\/models\/firebaseAdmin['"]\)/, 'controllers/firebaseAuthController.js'],
  ['Firebase route is mounted', /app\.use\(['"]\/api\/auth['"],\s+firebaseAuthRoutes\)/, 'server.js'],
  ['Google profile completion route exists', /router\.post\(['"]\/firebase\/complete-profile['"]/, 'routes/firebaseAuthRoutes.js'],
  ['Email password reset route exists', /router\.post\(['"]\/forgot-password\/email['"]/, 'routes/userRoutes.js'],
  ['Email reset endpoint exists in controller', /requestEmailPasswordReset/, 'controllers/userController.js'],
  ['Nodemailer dependency exists', /"nodemailer"\s*:/, 'package.json'],
  ['Google UID is hidden from JSON', /delete obj\.googleUid;/, 'models/User.js'],
];
let failed = 0;
for (const [name, pattern, file] of checks) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const ok = pattern.test(text);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);

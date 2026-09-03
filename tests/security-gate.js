'use strict';

/*
 * Phase 3.3 — Security & Abuse Gate
 *
 * Static/structural security assertions. These deliberately do not require
 * MongoDB, SMS, Cloudinary, or a production server. They verify that the
 * source contains the critical authorization, ownership, rate-limit and
 * anti-tampering controls before a live security test is attempted.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const server = read('server.js');
const auth = read('middleware/authMiddleware.js');
const roles = read('middleware/roleMiddleware.js');
const users = read('controllers/userController.js');
const vendor = read('controllers/vendorController.js');
const restaurant = read('controllers/restaurantController.js');
const order = read('controllers/orderController.js');
const rider = read('controllers/riderController.js');
const menu = read('controllers/menuController.js');
const authRoutes = read('routes/authRoutes.js');
const adminRoutes = read('routes/adminRoutes.js');
const riderRoutes = read('routes/riderRoutes.js');
const orderRoutes = read('routes/orderRoutes.js');
const vendorRoutes = read('routes/vendorRoutes.js');
const uploadRoutes = read('routes/uploadRoutes.js');

check('Helmet enabled', /app\.use\(helmet\(\)\)/.test(server));
check('Mongo operator sanitization enabled', /app\.use\(mongoSanitize\(\)\)/.test(server));
check('XSS middleware enabled', /app\.use\(xssClean\(\)\)/.test(server));
check('HPP protection enabled', /app\.use\(hpp\(/.test(server));
check('JSON body size capped', /express\.json\(\{\s*limit:\s*['"]10kb['"]/.test(server));
check('Rate limiter sees proxy client IP', /app\.set\(['"]trust proxy['"],\s*1\)/.test(server));
check('CORS uses explicit allow-list', /allowedCorsOrigins\.includes\(origin\)/.test(server));
check('CORS preflight uses explicit allow-list', /app\.options\(['"]\*['"],\s*cors\(\{/.test(server) && server.indexOf("app.options('*', cors());") === -1);
check('Authorization ignores JWT role claim and loads user from DB', /jwt\.verify\([\s\S]*?\n[\s\S]*?User\.findById\(decoded\.id\)/.test(auth));
check('Deactivated accounts rejected', /if \(!req\.user\.isActive\)/.test(auth));
check('Role middleware requires authenticated user', /if \(!req\.user\)/.test(roles));
check('Role middleware enforces exact DB role', /roles\.includes\(req\.user\.role\)/.test(roles));

check('Customer OTP has IP rate limit', /otpLimiter/.test(read('routes/userRoutes.js')));
check('Customer OTP has per-account resend throttle', /otpRequestedTooRecently/.test(users));
check('Customer OTP has per-account failed-attempt lockout', /checkOTP\(otp, ['"]login['"]\)/.test(users));
check('Password reset OTP has purpose separation', /checkOTP\(otp, ['"]password_reset['"]\)/.test(users));
check('Password reset token is hashed server-side', /createHash\(['"]sha256['"]\)/.test(users));
check('Password reset token expires', /passwordResetExpiresAt.*new Date\(Date\.now\(\) \+ 10 \* 60 \* 1000\)/s.test(read('models/User.js')));
check('No public vendor creation route', /router\.post\(['"]\/admin\/create-vendor['"],\s*protect,\s*authorize\(['"]admin['"]\)/.test(authRoutes));
check('Admin login is rate limited', /adminLoginLimiter/.test(adminRoutes));
check('Vendor login is rate limited', /loginLimiter/.test(authRoutes));
check('Rider login is rate limited', /router\.post\(['"]\/rider\/login['"],\s*loginLimiter/.test(authRoutes));

check('Vendor order queries are ownership scoped', /findOne\(\{ _id: req\.params\.id, \.\.\.restaurantOwnershipFilter\(req\) \}\)/.test(vendor));
check('Vendor menu updates are ownership scoped', /findOneAndUpdate\(\n\s*\{ _id: req\.params\.id, \.\.\.restaurantOwnershipFilter\(req\) \}/.test(vendor));
check('Vendor cannot overwrite restaurant linkage', /const \{[\s\S]*restaurantId,[\s\S]*\} = req\.body/.test(vendor));
check('Restaurant vendor edits use ownership check', /canManageRestaurant\(req\.user, existing\)/.test(restaurant));
check('Restaurant vendor fields use allow-list', /const VENDOR_EDITABLE = \[/.test(restaurant));
check('Menu item restaurant ownership is checked before vendor edit/delete', /canManageRestaurant\(req\.user, restaurant\)/.test(restaurant));
check('Customer order detail is user scoped', /Order\.findOne\(\{ _id: req\.params\.id, user: req\.user\._id \}\)/.test(order));
check('Customer cancellation is user scoped', /const order = await Order\.findOne\(\{ _id: req\.params\.id, user: req\.user\._id \}\)/.test(order));
check('Rider order detail is rider scoped', /Order\.findOne\(\{ _id: req\.params\.id, rider: req\.user\._id \}\)/.test(rider));
check('Rider status update is rider scoped', /Order\.findOne\(\{ _id: req\.params\.id, rider: req\.user\._id \}\)/.test(rider));
check('Rider OTP verification is rider scoped', /Order\.findOne\(\{ _id: req\.params\.id, rider: req\.user\._id \}\)/.test(rider));
check('Delivery OTP has failed-attempt lockout', /result\.reason === ['"]locked['"] \|\| result\.reason === ['"]locked_now['"]/.test(rider));
check('Delivery requires OTP before delivered', /status === ['"]delivered['"] && !order\.deliveryOtpVerified/.test(rider));
check('Admin rider assignment requires admin role', /router\.put\(['"]\/:id\/assign-rider['"],\s*protect,\s*authorize\(['"]admin['"]\)/.test(orderRoutes));
check('Rider routes require rider role', /router\.use\(protect, authorize\(['"]rider['"]\)\)/.test(riderRoutes));
check('Vendor routes require vendor role', /role\(['"]vendor['"]\)/.test(vendorRoutes));
check('Upload routes require auth and admin/vendor role', /router\.post\(['"]\/:type['"],\s*protect,\s*authorize\(['"]admin['"], ['"]vendor['"]\)/.test(uploadRoutes));

// Detect the two most dangerous accidental patterns in privileged updates.
check('No vendor raw req.body update on restaurant', !/findByIdAndUpdate\(req\.params\.id,\s*req\.body/.test(restaurant));
check('No vendor raw req.body update on menu item', !/findByIdAndUpdate\(req\.params\.id,\s*req\.body/.test(vendor));

console.log(`\nSecurity gate: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

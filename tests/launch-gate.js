#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const assert=require('assert');

const root=path.resolve(__dirname,'..');
const projectRoot=path.resolve(root,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const tests=[];
function check(name,fn){
  try{fn();tests.push(['PASS',name]);}
  catch(e){tests.push(['FAIL',name,e.message]);}
}

check('Liveness endpoint does not depend on MongoDB',()=>{
  const s=read('server.js');
  assert.match(s,/app\.get\(['"]\/live['"],\s*\(req,\s*res\)\s*=>\s*\{\s*res\.status\(200\)/);
});
check('Readiness endpoint reports MongoDB connectivity',()=>{
  const s=read('server.js');
  assert.match(s,/app\.get\(['"]\/ready['"],\s*\(req,\s*res\)\s*=>/);
  assert(s.includes('mongoose.connection.readyState === 1'));
  assert(s.includes('res.status(ready ? 200 : 503)'));
});
check('Legacy health endpoint remains available',()=>{
  assert(read('server.js').includes("app.get('/health'"));
});
check('Order lifecycle E2E is blocked until UPI test-mode flow exists',()=>{
  const s=read('tests/order-lifecycle-e2e.js');
  assert(s.includes('intentionally disabled'));
  assert(s.includes('UPI-only checkout'));
  assert(s.includes('No network request or database mutation was performed'));
  assert(s.includes('process.exit(2)'));
});
check('Deployment gate checks liveness and readiness before traffic',()=>{
  const s=read('tests/deployment-gate.js');
  assert(s.includes('`${apiOrigin}/live`'));
  assert(s.includes('`${apiOrigin}/ready`'));
  assert(s.includes('body.ready === true'));
});
check('New orders default to UPI; COD is opt-in and platform-gated',()=>{
  const s=read('models/Order.js');
  assert(s.includes("enum: ['upi', 'card', 'wallet', 'cod']"));
  assert(s.includes("default: 'upi'"));
  // Pillar 3: COD is no longer permanently disabled, but it is never granted
  // from client input alone — orderController must gate it on the platform
  // settings (isCodEnabled / maxCodOrderAmount) and the customer's COD block.
  const c=read('controllers/orderController.js');
  assert(c.includes("['upi', 'cod'].includes(requestedMethod)"));
  assert(c.includes('settings.isCodEnabled !== true'));
  assert(c.includes('settings.maxCodOrderAmount'));
  assert(c.includes('customer?.isCodBlocked === true'));
});
check('Cart payment endpoint accepts UPI only',()=>{
  assert(read('controllers/cartController.js').includes("paymentMethod !== 'upi'"));
  assert(read('models/Cart.js').includes("default: 'upi'"));
});
check('Order checkout resets cart to UPI',()=>{
  assert(read('controllers/paymentController.js').includes("paymentMethod: 'upi'"));
});
check('Restaurant creation/update cannot enable COD',()=>{
  const rc = read('controllers/restaurantController.js');
  // Non-admins cannot set the COD gate on create...
  assert(rc.includes('delete req.body.codEnabled'));
  // ...nor on update: the vendor allow-list must exclude it, and any non
  // privileged admin gets it stripped from the update payload.
  const start = rc.indexOf('const VENDOR_EDITABLE');
  const vendorEditable = rc.slice(start, rc.indexOf('];', start));
  assert(!vendorEditable.includes('codEnabled'), 'vendor allow-list must not expose codEnabled');
  assert(rc.includes('delete update.codEnabled'));
  // Vendor-created restaurants are born with COD off.
  assert(read('controllers/authController.js').includes('codEnabled: false'));
});
check('Rider history persists riderId',()=>{
  const s=read('models/Order.js');
  assert(s.includes('riderStatusHistory'));
  assert(s.includes('riderId:'));
});
check('Seeder supplies restaurant owners',()=>{
  const s=read('utils/seeder.js');
  assert(s.includes('owner: seedVendors[i]._id'));
  assert(s.includes('seedVendors[i].restaurantId = createdRestaurants[i]._id'));
});
check('Seeder uses numeric ratingCount',()=>{
  const s=read('utils/seeder.js');
  assert(!/ratingCount\s*:\s*['"]/.test(s));
});
check('Seeder uses restaurantId only for menu',()=>{
  const s=read('utils/seeder.js');
  assert(s.includes('restaurantId: restaurant._id'));
  assert(!/allMenuItems\.push\(\{[^}]*restaurant:\s*restaurant\._id/.test(s));
});
check('CORS has no obsolete Nearbite Vercel origin',()=>{
  const s=read('server.js');
  assert(!s.includes('nearbite-three.vercel.app'));
  assert(s.includes('process.env.CORS_ORIGINS'));
});
check('Admin authorization uses existing admin role',()=>{
  for(const p of ['routes/adminRoutes.js','routes/adminRiderRoutes.js','routes/orderRoutes.js','routes/restaurantRoutes.js','controllers/adminController.js']){
    assert(!/\bceo\b/i.test(read(p)), `${p} still contains ceo`);
  }
});
check('OTP provider dependencies declared',()=>{
  const pkg=JSON.parse(read('package.json'));
  assert(pkg.dependencies.axios);
  assert(pkg.dependencies.twilio);
});
if (fs.existsSync(path.join(projectRoot,'customer','cart.html'))) {
  check('Customer cart profile endpoint is correct',()=>{
    assert(fs.readFileSync(path.join(projectRoot,'customer','cart.html'),'utf8').includes('/users/profile'));
  });
  check('Customer login profile/password endpoints are correct',()=>{
    const s=fs.readFileSync(path.join(projectRoot,'customer','login.html'),'utf8');
    assert(s.includes('`${API_URL}/profile`'));
    assert(!s.includes('`${API_URL}/password`'));
  });
} else {
  console.log('SKIP Customer frontend checks (backend repository does not include customer source)');
}

let failed=0;
for(const [status,name,msg] of tests){
  console.log(`${status} ${name}${msg?` — ${msg}`:''}`);
  if(status==='FAIL') failed++;
}
console.log(`Launch-gate invariants: ${tests.length-failed} passed, ${failed} failed`);
process.exit(failed?1:0);

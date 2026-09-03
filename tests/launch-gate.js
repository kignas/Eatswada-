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

check('Order model is COD-only',()=>{
  const s=read('models/Order.js');
  assert(s.includes("enum: ['cod']"));
  assert(s.includes("default: 'cod'"));
});
check('Cart model is COD-only',()=>{
  const s=read('models/Cart.js');
  assert(s.includes("enum: ['cod']"));
  assert(s.includes("default: 'cod'"));
});
check('Cart controller rejects non-COD',()=>{
  assert(read('controllers/cartController.js').includes("const valid = ['cod'];"));
});
check('Order clear resets to COD',()=>{
  assert(read('controllers/orderController.js').includes("paymentMethod: 'cod'"));
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
check('Customer cart profile endpoint is correct',()=>{
  assert(fs.readFileSync(path.join(projectRoot,'customer','cart.html'),'utf8').includes('/users/profile'));
});
check('Customer login profile/password endpoints are correct',()=>{
  const s=fs.readFileSync(path.join(projectRoot,'customer','login.html'),'utf8');
  assert(s.includes('`${API_URL}/profile`'));
  assert(!s.includes('`${API_URL}/password`'));
});

let failed=0;
for(const [status,name,msg] of tests){
  console.log(`${status} ${name}${msg?` — ${msg}`:''}`);
  if(status==='FAIL') failed++;
}
console.log(`Launch-gate invariants: ${tests.length-failed} passed, ${failed} failed`);
process.exit(failed?1:0);

'use strict';
const fs=require('fs'); const path=require('path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const vendor=read('controllers/vendorMarketplaceController.js');
const routes=read('routes/vendorRoutes.js');
const menu=read('controllers/menuController.js');
const restaurant=read('controllers/restaurantController.js');
const order=read('controllers/orderController.js');
const checks=[
 ['new vendor menu items start pending',/approvalStatus:\s*'pending'/.test(vendor)],
 ['admin menu review queue only selects pending items',/approvalStatus:\s*'pending'/.test(menu)],
 ['admin approve/reject handler requires reason for rejection',/A rejection reason is required/.test(menu)],
 ['customer restaurant menu requires approved items',/approvalStatus:\s*'approved'/.test(restaurant)],
 ['checkout requires approved menu items',/approvalStatus:\s*'approved'/.test(order)],
 ['vendor dashboard route exists',/get\('\/dashboard'/.test(routes)],
 ['vendor alerts route exists',/get\('\/alerts'/.test(routes)],
 ['vendor activity route exists',/get\('\/activity'/.test(routes)],
 ['vendor profile route exists',/get\('\/profile'/.test(routes)],
 ['bulk availability route exists',/menu\/availability\/bulk/.test(routes)],
 ['menu reorder route exists',/menu\/reorder/.test(routes)],
 ['stock history route exists',/inventory\/history/.test(routes)],
 ['menu resubmission returns edited rejected item to pending',/\['approved',\s*'rejected'\]/.test(vendor)],
];
let failed=0; for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)failed++;}
console.log(`Vendor premium contract: ${checks.length-failed} passed, ${failed} failed`);process.exitCode=failed?1:0;

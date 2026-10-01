#!/usr/bin/env node
'use strict';

// Step 11 safety gate: the previous lifecycle test created COD orders, but
// Eatswada currently enforces UPI-only checkout. Never mutate a database with
// a payment flow that does not match production. Replace this gate only after
// a disposable staging environment and genuine Razorpay test-mode verification
// are available.
console.error('BLOCKED: order lifecycle E2E is intentionally disabled.');
console.error('Reason: previous test used COD while the current backend enforces UPI-only checkout.');
console.error('No network request or database mutation was performed.');
console.error('Required to enable: isolated staging DB + verified Razorpay test-mode payment flow + documented cleanup.');
process.exit(2);

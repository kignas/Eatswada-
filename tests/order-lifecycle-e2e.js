#!/usr/bin/env node
'use strict';

// Phase 3.2B — real order lifecycle E2E.
// Run ONLY against a disposable/test backend + test MongoDB.
// Required: TEST_BASE_URL, TEST_CONFIRM_MUTATIONS=EATSWADA_TEST_DB,
// TEST_ADMIN_TOKEN, TEST_VENDOR_TOKEN, TEST_RIDER_TOKEN, TEST_CUSTOMER_TOKEN,
// TEST_RESTAURANT_ID, TEST_MENU_ITEM_ID, TEST_RIDER_ID.
// The test creates one order and intentionally leaves it in the test database.

const assert = require('assert');

const BASE = (process.env.TEST_BASE_URL || '').replace(/\/$/, '');
const CONFIRM = process.env.TEST_CONFIRM_MUTATIONS;
const required = [
  'TEST_ADMIN_TOKEN', 'TEST_VENDOR_TOKEN', 'TEST_RIDER_TOKEN', 'TEST_CUSTOMER_TOKEN',
  'TEST_RESTAURANT_ID', 'TEST_MENU_ITEM_ID', 'TEST_RIDER_ID'
];
const results = [];

function pass(name) { results.push(['PASS', name]); }
function fail(name, err) { results.push(['FAIL', name, err.message || String(err)]); }
async function check(name, fn) {
  try { const value = await fn(); pass(name); return value; }
  catch (e) { fail(name, e); return null; }
}

function auth(token) { return { Authorization: `Bearer ${token}` }; }
async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    redirect: 'manual',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { res, body };
}
function expectStatus(res, codes, label) {
  assert(codes.includes(res.status), `${label}: expected ${codes.join('/')} got ${res.status}`);
}
function dataOf(body, label) {
  assert(body && body.success, `${label}: success=false`);
  assert(body.data, `${label}: missing data`);
  return body.data;
}

(async () => {
  if (!BASE) throw new Error('TEST_BASE_URL is required');
  if (CONFIRM !== 'EATSWADA_TEST_DB') throw new Error('Refusing mutation tests: set TEST_CONFIRM_MUTATIONS=EATSWADA_TEST_DB');
  if (!process.env.TEST_DB_NAME) throw new Error('TEST_DB_NAME is required and must identify a disposable test database');
  for (const name of required) if (!process.env[name]) throw new Error(`${name} is required`);

  const customer = process.env.TEST_CUSTOMER_TOKEN;
  const vendor = process.env.TEST_VENDOR_TOKEN;
  const rider = process.env.TEST_RIDER_TOKEN;
  const admin = process.env.TEST_ADMIN_TOKEN;
  const restaurantId = process.env.TEST_RESTAURANT_ID;
  const menuItemId = process.env.TEST_MENU_ITEM_ID;
  const riderId = process.env.TEST_RIDER_ID;

  await check('Test backend health', async () => {
    const { res } = await request('/health');
    assert(res.status < 500, `HTTP ${res.status}`);
  });

  let orderId = null;
  let orderNumber = null;
  let deliveryOtp = null;

  const created = await check('Customer creates COD order with server-authoritative pricing', async () => {
    const { res, body } = await request('/api/orders', {
      method: 'POST',
      headers: auth(customer),
      body: JSON.stringify({
        restaurantId,
        paymentMethod: 'cod',
        deliveryAddress: {
          tag: 'Test', house: '1', area: 'Maynaguri', landmark: 'E2E', city: 'Maynaguri', pincode: '735224',
          // Coordinates must be inside the restaurant's configured delivery radius.
          longitude: Number(process.env.TEST_CUSTOMER_LONGITUDE || 88.8200),
          latitude: Number(process.env.TEST_CUSTOMER_LATITUDE || 26.5350)
        },
        items: [{
          menuItem: menuItemId,
          name: 'CLIENT-SUPPLIED-NAME',
          price: 0.01,
          quantity: 1,
          image: 'client-fake-image',
          customizations: {}
        }],
        tipAmount: 0
      })
    });
    expectStatus(res, [201], 'create order');
    const data = dataOf(body, 'create order');
    assert(data.paymentMethod === 'cod', 'payment method must be COD');
    assert(Number(data.subtotal) > 0.01, 'server must not trust client item price');
    assert(data.orderNumber && data.shipmentId, 'public IDs missing');
    assert(body.deliveryOtp && /^\d{4}$/.test(String(body.deliveryOtp)), 'delivery OTP missing/invalid');
    orderId = data._id;
    orderNumber = data.orderNumber;
    deliveryOtp = String(body.deliveryOtp);
    return data;
  });
  if (!created) throw new Error('Cannot continue lifecycle without created order');

  await check('Vendor sees the new order', async () => {
    const { res, body } = await request('/api/vendor/orders?view=queue', { headers: auth(vendor) });
    expectStatus(res, [200], 'vendor queue');
    assert(Array.isArray(body.data), 'vendor queue data must be array');
    assert(body.data.some(o => String(o._id) === String(orderId)), `order ${orderNumber} not visible to vendor`);
  });

  await check('Vendor accepts order: placed -> confirmed', async () => {
    const { res, body } = await request(`/api/vendor/orders/${orderId}/accept`, { method: 'PUT', headers: auth(vendor), body: '{}' });
    expectStatus(res, [200], 'vendor accept');
    assert(body.data.status === 'confirmed', `status=${body.data.status}`);
  });

  await check('Vendor advances confirmed -> preparing', async () => {
    const { res, body } = await request(`/api/vendor/orders/${orderId}/status`, { method: 'PUT', headers: auth(vendor), body: JSON.stringify({ note: 'E2E preparing' }) });
    expectStatus(res, [200], 'vendor preparing');
    assert(body.data.status === 'preparing', `status=${body.data.status}`);
  });

  await check('Vendor advances preparing -> waiting_for_rider', async () => {
    const { res, body } = await request(`/api/vendor/orders/${orderId}/status`, { method: 'PUT', headers: auth(vendor), body: JSON.stringify({ note: 'E2E ready' }) });
    expectStatus(res, [200], 'vendor waiting_for_rider');
    assert(body.data.status === 'waiting_for_rider', `status=${body.data.status}`);
  });

  await check('Admin can assign the test rider', async () => {
    const { res, body } = await request(`/api/orders/${orderId}/assign-rider`, {
      method: 'PUT', headers: auth(admin), body: JSON.stringify({ riderId })
    });
    expectStatus(res, [200], 'assign rider');
    assert(String(body.data.rider) === String(riderId), 'wrong rider assigned');
    assert(body.data.riderStatus === 'assigned', `riderStatus=${body.data.riderStatus}`);
  });

  await check('Rider accepts assigned order: waiting_for_rider -> assigned', async () => {
    const { res, body } = await request(`/api/rider/orders/${orderId}/status`, {
      method: 'PUT', headers: auth(rider), body: JSON.stringify({ status: 'accepted', note: 'E2E accepted' })
    });
    expectStatus(res, [200], 'rider accepted');
    assert(body.data.status === 'assigned', `order status=${body.data.status}`);
    assert(body.data.riderStatus === 'accepted', `rider status=${body.data.riderStatus}`);
  });

  await check('Rider reaches restaurant', async () => {
    const { res, body } = await request(`/api/rider/orders/${orderId}/status`, {
      method: 'PUT', headers: auth(rider), body: JSON.stringify({ status: 'reached_restaurant' })
    });
    expectStatus(res, [200], 'rider reached restaurant');
    assert(body.data.riderStatus === 'reached_restaurant', `riderStatus=${body.data.riderStatus}`);
  });

  await check('Rider picks up order', async () => {
    const { res, body } = await request(`/api/rider/orders/${orderId}/status`, {
      method: 'PUT', headers: auth(rider), body: JSON.stringify({ status: 'picked_up' })
    });
    expectStatus(res, [200], 'rider picked up');
    assert(body.data.riderStatus === 'picked_up', `riderStatus=${body.data.riderStatus}`);
  });

  await check('Rider marks order out_for_delivery', async () => {
    const { res, body } = await request(`/api/rider/orders/${orderId}/status`, {
      method: 'PUT', headers: auth(rider), body: JSON.stringify({ status: 'out_for_delivery' })
    });
    expectStatus(res, [200], 'rider out for delivery');
    assert(body.data.status === 'out_for_delivery', `status=${body.data.status}`);
  });

  await check('Delivery cannot complete with wrong OTP', async () => {
    const { res } = await request(`/api/rider/orders/${orderId}/verify-otp`, {
      method: 'POST', headers: auth(rider), body: JSON.stringify({ otp: '0000' })
    });
    expectStatus(res, [400, 429], 'wrong OTP');
  });

  await check('Delivery OTP verifies successfully', async () => {
    const { res, body } = await request(`/api/rider/orders/${orderId}/verify-otp`, {
      method: 'POST', headers: auth(rider), body: JSON.stringify({ otp: deliveryOtp })
    });
    expectStatus(res, [200], 'verify OTP');
    assert(body.data.deliveryOtpVerified === true, 'OTP was not marked verified');
    assert(body.data.status === 'otp_verified', `status=${body.data.status}`);
  });

  await check('Rider completes delivery only after OTP verification', async () => {
    const { res, body } = await request(`/api/rider/orders/${orderId}/status`, {
      method: 'PUT', headers: auth(rider), body: JSON.stringify({ status: 'delivered' })
    });
    expectStatus(res, [200], 'complete delivery');
    assert(body.data.status === 'delivered', `status=${body.data.status}`);
    assert(body.data.paymentStatus === 'paid', `paymentStatus=${body.data.paymentStatus}`);
  });

  await check('Customer can retrieve the completed order', async () => {
    const { res, body } = await request(`/api/orders/${orderId}`, { headers: auth(customer) });
    expectStatus(res, [200], 'customer order');
    assert(body.data.status === 'delivered', `status=${body.data.status}`);
    assert(body.data.publicOrderId === orderNumber, 'public order ID mismatch');
  });

  let failed = 0;
  for (const [status, name, message] of results) {
    console.log(`${status} ${name}${message ? ` — ${message}` : ''}`);
    if (status === 'FAIL') failed++;
  }
  console.log(`Order-lifecycle E2E: ${results.length - failed} passed, ${failed} failed`);
  console.log(`Order: ${orderNumber || '(not created)'}`);
  console.log(`Test DB marker: ${process.env.TEST_DB_NAME}`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(`FATAL order-lifecycle E2E error: ${err.message}`);
  process.exit(2);
});

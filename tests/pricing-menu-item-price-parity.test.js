'use strict';

const assert = require('assert');
const { calculateItemServerPrice } = require('../services/pricing/menuItemPrice');

const menuItem = {
  price: 100,
  customizations: [
    { title: 'Portion', pricingMode: 'portion', options: [
      { label: 'Half', extraPrice: 60 },
      { label: 'Full', extraPrice: 150 },
    ] },
    { title: 'Add-ons', pricingMode: 'extra', options: [
      { label: 'Cheese', extraPrice: 20 },
      { label: 'Paneer', extraPrice: 35 },
    ] },
  ],
};

function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.message}`); process.exitCode = 1; }
}

test('base item price remains unchanged without customizations', () => {
  assert.strictEqual(calculateItemServerPrice(menuItem, []), 100);
});

test('portion option replaces base price', () => {
  assert.strictEqual(calculateItemServerPrice(menuItem, [{ title: 'Portion', selected: ['Full'] }]), 150);
});

test('extra option adds to base price', () => {
  assert.strictEqual(calculateItemServerPrice(menuItem, [{ title: 'Add-ons', selected: ['Cheese'] }]), 120);
});

test('portion and extras combine identically for quote and order callers', () => {
  const selections = [
    { title: 'Portion', selected: ['Full'] },
    { title: 'Add-ons', selected: ['Cheese', 'Paneer'] },
  ];
  const quoteUnitPrice = calculateItemServerPrice(menuItem, selections);
  const orderUnitPrice = calculateItemServerPrice(menuItem, selections);
  assert.strictEqual(quoteUnitPrice, 205);
  assert.strictEqual(orderUnitPrice, quoteUnitPrice);
  assert.strictEqual(quoteUnitPrice * 2, 410);
});

test('legacy flat customization labels remain supported', () => {
  assert.strictEqual(calculateItemServerPrice(menuItem, ['Full', 'Cheese']), 170);
});

test('client-supplied option price is ignored', () => {
  const selections = [{ title: 'Add-ons', options: [{ label: 'Cheese', extraPrice: 9999 }] }];
  assert.strictEqual(calculateItemServerPrice(menuItem, selections), 120);
});

test('invalid customization is rejected', () => {
  assert.throws(() => calculateItemServerPrice(menuItem, [{ title: 'Add-ons', selected: ['Gold'] }]), /Invalid option/);
});

test('multiple portion selections are rejected', () => {
  assert.throws(() => calculateItemServerPrice(menuItem, [{ title: 'Portion', selected: ['Half', 'Full'] }]), /only one portion/);
});

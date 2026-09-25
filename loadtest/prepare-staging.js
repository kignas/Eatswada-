#!/usr/bin/env node
/**
 * Eatswada load-test data prep — STAGING DATABASE ONLY.
 *
 *   node loadtest/prepare-staging.js setup     create test customers + top up menus + write tokens.json
 *   node loadtest/prepare-staging.js cleanup   remove everything setup created
 *
 * Env (read from .env like the server):
 *   MONGO_URI                 staging connection string (database name MUST contain test/staging/load)
 *   JWT_SECRET                the SAME secret the staging server uses (so tokens are valid)
 *   LT_USERS=50               number of test customers
 *   LT_ITEMS_PER_RESTAURANT=60  top each approved restaurant up to this many menu items
 *                             (6 restaurants x 60 ≈ 350 items; use 350 to test the worst case)
 *
 * Everything it creates is tagged so cleanup is exact:
 *   customers: phone +9199000100NN, name "Load Test NN"
 *   menu items: name starts with "[LT] "
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const fs = require('fs');
const mongoose = require('mongoose');
const User = require('../models/User');
const Restaurant = require('../models/Restaurant');
const MenuItem = require('../models/Menu');
const Cart = require('../models/Cart');
const generateToken = require('../utils/generateToken');

const MODE = process.argv[2];
const USERS = Math.max(1, Number(process.env.LT_USERS) || 50);
const ITEMS_PER_RESTAURANT = Math.max(1, Number(process.env.LT_ITEMS_PER_RESTAURANT) || 60);
const PHONE_PREFIX = '+9199000100';
const ITEM_PREFIX = '[LT] ';
const TOKENS_FILE = path.join(__dirname, 'tokens.json');

const DISHES = [
  ['Chicken Biryani', 'Biryani', false, 180], ['Veg Biryani', 'Biryani', true, 140], ['Egg Roll', 'Rolls', false, 60],
  ['Paneer Roll', 'Rolls', true, 80], ['Chicken Momo', 'Momos', false, 90], ['Veg Momo', 'Momos', true, 70],
  ['Fish Curry Thali', 'Thali', false, 160], ['Veg Thali', 'Thali', true, 120], ['Chowmein', 'Chinese', true, 70],
  ['Chilli Chicken', 'Chinese', false, 150], ['Masala Dosa', 'South Indian', true, 90], ['Kathi Roll', 'Rolls', false, 95],
  ['Aloo Paratha', 'Breakfast', true, 50], ['Mutton Kosha', 'Bengali', false, 260], ['Mishti Doi', 'Desserts', true, 40],
  ['Rasgulla (2 pc)', 'Desserts', true, 30], ['Cold Coffee', 'Beverages', true, 70], ['Lassi', 'Beverages', true, 50],
  ['Chicken Burger', 'Burgers', false, 110], ['Veg Burger', 'Burgers', true, 80], ['French Fries', 'Snacks', true, 60],
  ['Paneer Butter Masala', 'Main Course', true, 170], ['Butter Naan', 'Breads', true, 35], ['Egg Curry', 'Main Course', false, 90],
];

async function connect() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set.');
  if (!process.env.JWT_SECRET && MODE === 'setup') throw new Error('JWT_SECRET is not set (must match the staging server).');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const dbName = mongoose.connection.name || '';
  if (!/(test|staging|load)/i.test(dbName)) {
    await mongoose.disconnect();
    throw new Error(
      `Refusing to run: database "${dbName}" does not look like a staging/test database.\n` +
      'Point MONGO_URI at a copy of your data whose database name contains "test", "staging" or "load".'
    );
  }
  console.log(`Connected to staging database "${dbName}"`);
}

async function setup() {
  // 1) Test customers + JWTs
  const tokens = [];
  for (let i = 1; i <= USERS; i++) {
    const nn = String(i).padStart(2, '0');
    const phone = `${PHONE_PREFIX}${nn}`;
    let user = await User.findOne({ phone });
    if (!user) {
      user = await User.create({ phone, name: `Load Test ${nn}`, role: 'user', isActive: true, isPhoneVerified: true });
    }
    tokens.push(generateToken(user._id, 'user', user.tokenVersion || 0));
  }
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  console.log(`✔ ${tokens.length} test customers ready → ${path.relative(process.cwd(), TOKENS_FILE)}`);

  // 2) Top every approved restaurant up to ITEMS_PER_RESTAURANT menu items
  const restaurants = await Restaurant.find({ isActive: true, approvalStatus: 'approved' }).select('_id name').lean();
  if (!restaurants.length) console.warn('⚠ No approved restaurants found. Add/approve restaurants on staging first.');
  let added = 0;
  for (const r of restaurants) {
    const have = await MenuItem.countDocuments({ restaurantId: r._id });
    const need = Math.max(0, ITEMS_PER_RESTAURANT - have);
    const docs = [];
    for (let k = 0; k < need; k++) {
      const [name, category, isVeg, price] = DISHES[k % DISHES.length];
      const variant = Math.floor(k / DISHES.length) + 1;
      const finalPrice = price + (variant - 1) * 10;
      docs.push({
        restaurantId: r._id,
        name: `${ITEM_PREFIX}${name}${variant > 1 ? ` ${variant}` : ''}`,
        description: `Freshly made ${name.toLowerCase()} — load-test item.`,
        price: finalPrice,
        originalPrice: k % 5 === 0 ? finalPrice + 20 : undefined,
        isVeg, category,
        isUnder99: finalPrice <= 99,
        isBestseller: k % 11 === 0,
        inStock: k % 17 !== 0, // a few out-of-stock items, like real menus
        sortOrder: k,
      });
    }
    if (docs.length) await MenuItem.insertMany(docs);
    added += docs.length;
    console.log(`  ${r.name}: ${have} existing + ${docs.length} added`);
  }
  const total = await MenuItem.countDocuments({ restaurantId: { $in: restaurants.map(r => r._id) } });
  console.log(`✔ Menu: ${added} test items added, ${total} items across ${restaurants.length} restaurants`);
}

async function cleanup() {
  const users = await User.find({ phone: { $regex: `^\\${PHONE_PREFIX}` } }).select('_id').lean();
  const ids = users.map(u => u._id);
  const carts = await Cart.deleteMany({ user: { $in: ids } });
  const u = await User.deleteMany({ _id: { $in: ids } });
  const m = await MenuItem.deleteMany({ name: { $regex: '^\\[LT\\] ' } });
  if (fs.existsSync(TOKENS_FILE)) fs.unlinkSync(TOKENS_FILE);
  console.log(`✔ Removed ${u.deletedCount} test customers, ${carts.deletedCount} carts, ${m.deletedCount} test menu items`);
}

(async () => {
  if (!['setup', 'cleanup'].includes(MODE)) {
    console.log('Usage: node loadtest/prepare-staging.js setup|cleanup');
    process.exit(1);
  }
  try {
    await connect();
    if (MODE === 'setup') await setup(); else await cleanup();
  } catch (err) {
    console.error(`✖ ${err.message}`);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
})();

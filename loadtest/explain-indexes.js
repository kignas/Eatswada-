#!/usr/bin/env node
/**
 * READ-ONLY index check for Eatswada's hot queries.
 *
 * Runs MongoDB explain('executionStats') for the same filters/sorts the
 * controllers use and prints, per query, whether MongoDB used an index
 * (IXSCAN / IDHACK / GEO / TEXT) or scanned the whole collection (COLLSCAN),
 * plus keys/docs examined. It never writes and never creates indexes
 * (autoIndex/autoCreate are forced off for this script).
 *
 * Usage (from the backend folder, after `npm install`):
 *   MONGO_URI='mongodb+srv://...' node loadtest/explain-indexes.js
 * Optional env: SEARCH_Q=chicken  LAT=26.56  LNG=88.82
 *
 * Run it once BEFORE deploying the performance changes and once AFTER the new
 * server version has started (Mongoose builds new schema indexes on startup).
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

const Restaurant = require('../models/Restaurant');
const MenuItem = require('../models/Menu');
const Category = require('../models/Category');
const HomeBanner = require('../models/HomeBanner');
const Review = require('../models/Review');
const Order = require('../models/Order');
const Cart = require('../models/Cart');
const Notification = require('../models/Notification');

const SEARCH_Q = String(process.env.SEARCH_Q || 'chicken');
const LAT = Number(process.env.LAT) || 26.56;
const LNG = Number(process.env.LNG) || 88.82;
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function summarize(explain) {
  const stages = new Set();
  const indexes = new Set();
  let stats = null;
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.stage === 'string') stages.add(node.stage);
    if (typeof node.indexName === 'string') indexes.add(node.indexName);
    if (!stats && node.executionStats && node.executionStats.totalDocsExamined !== undefined) stats = node.executionStats;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'rejectedPlans' || key === 'allPlansExecution') continue;
      walk(value);
    }
  })(explain);

  let plan;
  if (stages.has('COLLSCAN')) plan = 'COLLSCAN (no index used)';
  else if (stages.has('IDHACK') || stages.has('EXPRESS_IXSCAN') || stages.has('EXPRESS_CLUSTERED_IXSCAN')) plan = 'IDHACK (_id lookup)';
  else if (indexes.size) plan = `IXSCAN ${[...indexes].join(', ')}`;
  else if ([...stages].some((s) => s.startsWith('GEO_NEAR'))) plan = 'GEO_NEAR (2dsphere)';
  else plan = [...stages].join('>') || 'unknown';
  if (stages.has('SORT')) plan += ' +in-memory SORT';

  return {
    plan,
    keys: stats ? stats.totalKeysExamined : '?',
    docs: stats ? stats.totalDocsExamined : '?',
    returned: stats ? stats.nReturned : '?',
    ms: stats ? stats.executionTimeMillis : '?',
  };
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('Set MONGO_URI (same value as on Render).');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false, maxPoolSize: 2 });
  const oid = () => new mongoose.Types.ObjectId();

  // Real sample ids (read-only lookups), falling back to random ids.
  const sampleRestaurant = await Restaurant.findOne({ isActive: true, approvalStatus: 'approved' }).select('_id').lean();
  const sampleOrder = await Order.findOne({}).sort({ _id: -1 }).select('user restaurant').lean();
  const sampleRiderOrder = await Order.findOne({ rider: { $ne: null } }).sort({ _id: -1 }).select('rider').lean();
  const sampleRing = await Notification.findOne({ 'data.kind': 'new_order' }).sort({ _id: -1 }).select('data.orderId').lean();

  const restaurantId = sampleRestaurant ? sampleRestaurant._id : oid();
  const userId = sampleOrder ? sampleOrder.user : oid();
  const vendorRestaurantId = sampleOrder ? sampleOrder.restaurant : restaurantId;
  const riderId = sampleRiderOrder ? sampleRiderOrder.rider : oid();
  const ringOrderId = sampleRing && sampleRing.data && sampleRing.data.orderId ? String(sampleRing.data.orderId) : String(oid());
  const regex = new RegExp(escapeRegex(SEARCH_Q), 'i');
  const now = new Date();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

  const checks = [
    ['GET /api/restaurants (listing aggregate)', () => Restaurant.aggregate([
      { $match: { isActive: true, approvalStatus: 'approved' } },
      { $addFields: { __isOpen: { $eq: ['$availability.isOpen', true] }, __homeOrder: { $ifNull: ['$homeOrder', 999999] } } },
      { $facet: { total: [{ $count: 'n' }], data: [{ $sort: { __isOpen: -1, __homeOrder: 1, isFeatured: -1, displayPriority: -1, rating: -1, createdAt: -1 } }, { $limit: 20 }, { $project: { _id: 1, name: 1 } }] } },
    ]).explain('executionStats')],
    [`GET /api/restaurants?search=${SEARCH_Q} ($text)`, () => Restaurant.aggregate([
      { $match: { isActive: true, approvalStatus: 'approved', $text: { $search: SEARCH_Q } } },
      { $limit: 20 },
    ]).explain('executionStats')],
    ['GET /api/restaurants/serviceability ($geoNear)', () => Restaurant.aggregate([
      { $geoNear: { near: { type: 'Point', coordinates: [LNG, LAT] }, key: 'location', distanceField: 'distanceMeters', spherical: true, maxDistance: 10000, query: { isActive: true, approvalStatus: 'approved' } } },
      { $limit: 1 },
    ]).explain('executionStats')],
    ['GET /api/restaurants/:id', () => Restaurant.findOne({ _id: restaurantId, isActive: true, approvalStatus: 'approved' }).explain('executionStats')],
    ['GET /api/restaurants/:id/menu', () => MenuItem.find({ restaurantId }).sort({ category: 1, name: 1 }).explain('executionStats')],
    ['GET /api/restaurants/under99 (distinct)', () => mongoose.connection.db.command({
      explain: { distinct: MenuItem.collection.collectionName, key: 'restaurantId', query: { price: { $lte: 99 }, inStock: true } },
      verbosity: 'executionStats',
    })],
    ['GET /api/restaurants/under99 (menus)', () => MenuItem.find({ restaurantId: { $in: [restaurantId] } }).sort({ price: 1, sortOrder: 1, name: 1 }).explain('executionStats')],
    [`GET /api/restaurants/search?q=${SEARCH_Q} (menu regex)`, () => MenuItem.find({ inStock: true, $or: [{ name: regex }, { category: regex }, { description: regex }] })
      .sort({ isBestseller: -1, isRecommended: -1, sortOrder: 1, name: 1 }).limit(30).explain('executionStats')],
    ['GET /api/restaurants/search (visible restaurants)', () => Restaurant.find({ isActive: true, approvalStatus: 'approved', $or: [{ 'availability.isOpen': true }, { isOpen: true }] }).explain('executionStats')],
    ['GET /api/restaurants/:id/reviews', () => Review.find({ restaurant: restaurantId, isVisible: true }).sort({ createdAt: -1 }).limit(10).explain('executionStats')],
    ['GET /api/categories (cache miss only)', () => Category.find({ isActive: true }).sort({ order: 1, name: 1 }).explain('executionStats')],
    ['GET /api/home-banners (cache miss only)', () => HomeBanner.find({ placement: 'home', active: true }).sort({ priority: -1, createdAt: -1 }).explain('executionStats')],
    ['GET /api/cart', () => Cart.findOne({ user: userId }).explain('executionStats')],
    ['GET /api/orders (my orders)', () => Order.find({ user: userId }).sort({ createdAt: -1 }).limit(10).explain('executionStats')],
    ['GET /api/vendor/orders?view=queue', () => Order.find({
      restaurant: vendorRestaurantId,
      status: { $in: ['placed', 'confirmed', 'preparing', 'waiting_for_rider', 'assigned', 'out_for_delivery'] },
      $or: [{ paymentMethod: 'cod' }, { paymentMethod: { $ne: 'cod' }, paymentStatus: 'paid' }],
    }).sort({ createdAt: -1 }).explain('executionStats')],
    ['GET /api/riders/orders/active', () => Order.find({ rider: riderId, riderStatus: { $in: ['assigned', 'accepted', 'reached_restaurant', 'picked_up', 'out_for_delivery'] } }).sort({ riderAssignedAt: -1 }).limit(1).explain('executionStats')],
    ['stopRing() on vendor accept/reject', () => Notification.find({ 'data.orderId': ringOrderId, 'data.kind': 'new_order' }).explain('executionStats')],
    ['(admin) dashboard orders today — informational', () => Order.find({ createdAt: { $gte: todayStart } }).explain('executionStats')],
  ];

  console.log(`\nEatswada index check — ${now.toISOString()}  (read-only)\n`);
  const counts = {};
  for (const [name, model] of Object.entries({ restaurants: Restaurant, menus: MenuItem, orders: Order, notifications: Notification, reviews: Review })) {
    counts[name] = await model.estimatedDocumentCount();
  }
  console.log('Collection sizes:', Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '), '\n');

  const rows = [];
  for (const [label, run] of checks) {
    try {
      rows.push({ query: label, ...summarize(await run()) });
    } catch (err) {
      rows.push({ query: label, plan: `ERROR: ${err.message}`, keys: '', docs: '', returned: '', ms: '' });
    }
  }
  console.table(rows);

  const notifIndexes = (await Notification.collection.indexes()).map((i) => i.name);
  const hasRingIndex = notifIndexes.includes('data.orderId_1_kind_new_order');
  console.log(`\nnotifications index data.orderId_1_kind_new_order: ${hasRingIndex ? 'PRESENT' : 'MISSING (created automatically when the new server version starts)'}`);
  console.log('Tip: a COLLSCAN row with docs ≈ collection size is a full scan; IXSCAN/IDHACK rows should examine few docs.\n');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('explain-indexes failed:', err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});

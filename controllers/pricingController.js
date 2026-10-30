'use strict';

// ─────────────────────────────────────────────────────────────────────
// Pricing controller — customer-facing quote + restaurant-card pricing.
//
// Every value returned here is computed server-side. The client may only send
// WHICH restaurant and WHICH address it is asking about; it can never send a
// price, fee, distance, commission or payout.
// ─────────────────────────────────────────────────────────────────────

const mongoose = require('mongoose');
const asyncHandler = require('express-async-handler');

const Restaurant = require('../models/Restaurant');
const Menu = require('../models/Menu');
const Address = require('../models/Address');
const Order = require('../models/Order');

const { resolvePricingRules } = require('../services/pricing/pricingRules');
const { createQuote } = require('../services/pricing/quoteService');
const { buildRestaurantCardPricing } = require('../services/pricing/pricingOrchestrator');
const { validCoordinates } = require('../services/deliveryPricing');

/** Resolve the customer's verified delivery coordinates (never client-supplied). */
async function resolveCustomerCoords({ addressId, userId }) {
  if (!addressId || !mongoose.Types.ObjectId.isValid(String(addressId))) return null;
  const address = await Address.findOne({ _id: addressId, user: userId }).lean();
  if (!address) return null;
  const coords = address.location?.coordinates;
  return validCoordinates(coords) ? [Number(coords[0]), Number(coords[1])] : null;
}

/** Resolve server-side item prices for a quote request (never client prices). */
async function resolveItems(restaurantId, requestedItems) {
  const list = Array.isArray(requestedItems) ? requestedItems : [];
  if (!list.length) {
    const err = new Error('At least one item is required to build a quote.');
    err.statusCode = 400;
    throw err;
  }

  const ids = list
    .map(it => it?.menuItem || it?.menuId || it?.id || it?._id)
    .filter(id => mongoose.Types.ObjectId.isValid(String(id)))
    .map(String);
  if (!ids.length) {
    const err = new Error('No valid menu items were supplied.');
    err.statusCode = 400;
    throw err;
  }

  const docs = await Menu.find({
    _id: { $in: [...new Set(ids)] },
    restaurantId,
    isActive: { $ne: false },
  }).select('price').lean();
  const priceMap = new Map(docs.map(d => [String(d._id), Math.max(0, Number(d.price) || 0)]));

  const items = [];
  for (const requested of list) {
    const id = String(requested?.menuItem || requested?.menuId || requested?.id || requested?._id || '');
    const price = priceMap.get(id);
    if (price === undefined) {
      const err = new Error('One or more items no longer belong to this restaurant. Please refresh.');
      err.statusCode = 409;
      throw err;
    }
    const quantity = Math.max(1, Math.min(99, Math.floor(Number(requested?.quantity) || 1)));
    items.push({ quantity, unitPriceRupees: price });
  }
  return items;
}

/**
 * POST /api/pricing/quote
 * Body: { restaurantId, addressId, items:[{menuItem,quantity}], paymentMethod?, couponCode? }
 */
exports.quote = asyncHandler(async (req, res) => {
  const restaurantId = req.body?.restaurantId;
  if (!mongoose.Types.ObjectId.isValid(String(restaurantId || ''))) {
    return res.status(400).json({ success: false, message: 'A valid restaurantId is required.' });
  }

  const restaurant = await Restaurant.findOne({ _id: restaurantId, isActive: true, approvalStatus: 'approved' })
    .select('name image location deliveryRadiusKm deliveryMode commissionRate commissionPlan minOrder codEnabled')
    .lean();
  if (!restaurant) {
    return res.status(404).json({ success: false, message: 'Restaurant not found or unavailable.' });
  }

  const customerCoords = await resolveCustomerCoords({ addressId: req.body?.addressId, userId: req.user._id });
  if (!customerCoords) {
    return res.status(400).json({ success: false, message: 'Select a saved delivery address with a verified map location first.' });
  }

  const items = await resolveItems(restaurantId, req.body?.items);
  const rules = await resolvePricingRules();
  const isFirstOrder = !(await Order.exists({ user: req.user._id }));
  const paymentMethod = String(req.body?.paymentMethod || 'upi').toLowerCase() === 'cod' ? 'cod' : 'upi';

  const quote = await createQuote({
    rules,
    restaurant: {
      _id: restaurant._id,
      location: restaurant.location,
      deliveryRadiusKm: restaurant.deliveryRadiusKm,
      // The SAME gate the checkout uses: the legacy commission model is opt-in
      // and only applies to a restaurant actually on a legacy/custom plan.
      // `commissionRate` alone is useless here because it defaults to 15 for
      // every restaurant — keying on it would put everyone on commission and
      // the food-price uplift would never apply, so the quote endpoint and the
      // checkout would disagree on the price.
      commissionable: rules.legacyCommissionModelEnabled === true
        && ['legacy', 'custom'].includes(String(restaurant.commissionPlan || ''))
        && Number(restaurant.commissionRate) > 0,
      commissionRate: restaurant.commissionRate,
    },
    items,
    customerCoords,
    paymentMethod,
    isFirstOrder,
    cacheKeyPrefix: `q:${restaurant._id}:${req.body?.addressId || ''}`,
  });

  if (quote.serviceable === false) {
    return res.status(409).json({
      success: false,
      code: quote.reason || 'NOT_ECONOMICALLY_SERVICEABLE',
      message: quote.message || 'This delivery is not available right now.',
      data: quote,
    });
  }

  return res.json({ success: true, data: quote });
});

/**
 * GET /api/pricing/restaurant-cards?addressId=...&restaurantIds=a,b,c
 * The SAME engine the checkout uses, so a card can never disagree with the bill.
 */
exports.restaurantCards = asyncHandler(async (req, res) => {
  const rawIds = String(req.query?.restaurantIds || '')
    .split(',').map(s => s.trim()).filter(id => mongoose.Types.ObjectId.isValid(id)).slice(0, 30);
  if (!rawIds.length) {
    return res.status(400).json({ success: false, message: 'Provide at least one valid restaurantIds value.' });
  }

  const customerCoords = await resolveCustomerCoords({ addressId: req.query?.addressId, userId: req.user._id });
  if (!customerCoords) {
    return res.status(400).json({ success: false, message: 'Select a saved delivery address with a verified map location first.' });
  }

  const rules = await resolvePricingRules();
  const isFirstOrder = !(await Order.exists({ user: req.user._id }));
  const restaurants = await Restaurant.find({ _id: { $in: rawIds }, isActive: true, approvalStatus: 'approved' })
    .select('name image location deliveryRadiusKm deliveryMode commissionRate')
    .lean();

  const cards = await Promise.all(restaurants.map(restaurant => buildRestaurantCardPricing({
    rules,
    restaurant: { _id: restaurant._id, location: restaurant.location, deliveryRadiusKm: restaurant.deliveryRadiusKm },
    customerCoords,
    eligibleSubtotalRupees: Number(req.query?.eligibleSubtotal || 0),
    isFirstOrder,
    cacheKeyPrefix: `card:${restaurant._id}`,
  })));

  res.set('Cache-Control', 'no-store');
  return res.json({ success: true, data: { pricingVersion: rules.version, cards } });
});

/**
 * GET /api/pricing/config
 * The customer-safe subset of the pricing configuration the frontend needs to
 * render fee labels. No admin-only assumptions (fuel price, risk allowances,
 * contribution tiers) are exposed.
 */
exports.publicConfig = asyncHandler(async (req, res) => {
  const rules = await resolvePricingRules();
  res.set('Cache-Control', 'no-store');
  return res.json({
    success: true,
    data: {
      pricingVersion: rules.version,
      pricingEngineEnabled: rules.pricingEngineEnabled === true,
      foodPriceUpliftPercent: rules.foodPriceUpliftPercent,
      deliveryFeeBands: rules.deliveryFeeBands,
      maxDeliveryDistanceKm: rules.maxDeliveryDistanceKm,
      freeDeliveryEnabled: rules.freeDeliveryEnabled !== false,
      freeDeliveryThreshold: rules.freeDeliveryThreshold,
      firstOrderFreeDeliveryEnabled: rules.firstOrderFreeDeliveryEnabled !== false,
      firstOrderFreeDeliveryMaxKm: rules.firstOrderFreeDeliveryMaxKm,
      firstOrderFreeDeliveryMinBasket: rules.firstOrderFreeDeliveryMinBasket,
      smallOrderFeeEnabled: rules.smallOrderFeeEnabled !== false,
      smallOrderFeeMax: rules.smallOrderFeeMax,
      codHandlingFeeEnabled: rules.codHandlingFeeEnabled !== false,
      codHandlingFeeMax: rules.codHandlingFeeMax,
    },
  });
});

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
const { calculateItemServerPrice } = require('../services/pricing/menuItemPrice');

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

  const requestedIds = list.map(it => it?.menuItem || it?.menuId || it?.id || it?._id);
  if (requestedIds.some(id => !mongoose.Types.ObjectId.isValid(String(id || '')))) {
    const err = new Error('One or more cart items are invalid or outdated. Please refresh your cart.');
    err.statusCode = 400;
    throw err;
  }

  const ids = [...new Set(requestedIds.map(String))];
  const docs = await Menu.find({
    _id: { $in: ids },
    restaurantId,
    isActive: { $ne: false },
    $or: [{ approvalStatus: 'approved' }, { approvalStatus: { $exists: false } }],
  }).lean();
  const menuMap = new Map(docs.map(doc => [String(doc._id), doc]));

  const items = [];
  for (let index = 0; index < list.length; index += 1) {
    const requested = list[index];
    const id = String(requestedIds[index]);
    const menuItem = menuMap.get(id);
    if (!menuItem) {
      const err = new Error('A cart item no longer belongs to this restaurant. Please refresh your cart.');
      err.statusCode = 409;
      throw err;
    }
    if (menuItem.isActive === false || (menuItem.approvalStatus && menuItem.approvalStatus !== 'approved')) {
      const err = new Error(`${menuItem.name || 'This item'} is not currently approved for ordering.`);
      err.statusCode = 409;
      throw err;
    }
    if (menuItem.inStock === false || (menuItem.trackStock === true && Number(menuItem.stockQuantity || 0) <= 0)) {
      const err = new Error(`${menuItem.name || 'This item'} is currently out of stock.`);
      err.statusCode = 409;
      throw err;
    }
    const quantity = Number(requested?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      const err = new Error(`Invalid quantity for ${menuItem.name || 'menu item'}.`);
      err.statusCode = 400;
      throw err;
    }
    if (menuItem.trackStock && Number(menuItem.stockQuantity) < quantity) {
      const err = new Error(`${menuItem.name || 'This item'} has only ${Math.max(0, Number(menuItem.stockQuantity) || 0)} unit(s) remaining.`);
      err.statusCode = 409;
      throw err;
    }

    items.push({
      quantity,
      unitPriceRupees: calculateItemServerPrice(menuItem, requested.customizations),
    });
  }
  return items;
}

/**
 * The engine is opt-in. createOrder only prices with it when
 * `pricingEngineEnabled === true`, so the quote and card endpoints must follow
 * the SAME strict check — otherwise the cart shows engine prices while the
 * order is charged the legacy price. Keep this identical to the check in
 * controllers/orderController.js.
 */
function engineEnabled(rules) {
  return rules?.pricingEngineEnabled === true;
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

  const rules = await resolvePricingRules();
  if (!engineEnabled(rules)) {
    // Not an error in the quote itself: the engine is switched off, so orders
    // use the legacy price. Return no quote data so no client can show or
    // trust an engine price that checkout will not charge.
    return res.status(409).json({
      success: false,
      code: 'PRICING_ENGINE_DISABLED',
      message: 'Dynamic pricing is not active.',
    });
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
  const isFirstOrder = !(await Order.exists({ user: req.user._id }));
  const paymentMethod = String(req.body?.paymentMethod || 'upi').toLowerCase() === 'cod' ? 'cod' : 'upi';

  const quote = await createQuote({
    rules,
    restaurant: {
      _id: restaurant._id,
      location: restaurant.location,
      deliveryRadiusKm: restaurant.deliveryRadiusKm,
      minOrder: restaurant.minOrder,
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
    // Binds the signed quoteId to this customer so POST /orders can verify it.
    userId: req.user._id,
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

  const rules = await resolvePricingRules();
  if (!engineEnabled(rules)) {
    // Engine off: no engine prices. An empty list lets clients fall back to
    // the legacy display instead of showing a price checkout will not charge.
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, data: { pricingVersion: rules?.version, engineEnabled: false, cards: [] } });
  }

  const customerCoords = await resolveCustomerCoords({ addressId: req.query?.addressId, userId: req.user._id });
  if (!customerCoords) {
    return res.status(400).json({ success: false, message: 'Select a saved delivery address with a verified map location first.' });
  }

  const isFirstOrder = !(await Order.exists({ user: req.user._id }));
  const restaurants = await Restaurant.find({ _id: { $in: rawIds }, isActive: true, approvalStatus: 'approved' })
    .select('name image location deliveryRadiusKm deliveryMode commissionRate commissionPlan minOrder')
    .lean();

  const cards = await Promise.all(restaurants.map(restaurant => buildRestaurantCardPricing({
    rules,
    restaurant: {
      _id: restaurant._id,
      location: restaurant.location,
      deliveryRadiusKm: restaurant.deliveryRadiusKm,
      minOrder: restaurant.minOrder,
      commissionRate: restaurant.commissionRate,
      commissionable: rules.legacyCommissionModelEnabled === true
        && ['legacy', 'custom'].includes(String(restaurant.commissionPlan || ''))
        && Number(restaurant.commissionRate) > 0,
    },
    customerCoords,
    eligibleSubtotalRupees: Number(req.query?.eligibleSubtotal || 0),
    isFirstOrder,
    cacheKeyPrefix: `card:${restaurant._id}`,
  })));

  res.set('Cache-Control', 'no-store');
  return res.json({ success: true, data: { pricingVersion: rules.version, engineEnabled: true, cards } });
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

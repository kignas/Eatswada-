const mongoose   = require('mongoose');
const Cart       = require('../models/Cart');
const MenuItem   = require('../models/Menu');
const Restaurant = require('../models/Restaurant');
const asyncHandler = require('express-async-handler');
const {
  DELIVERY_RULES,
  calculateDeliveryFee,
} = require('../services/deliveryPricing');

// ─────────────────────────────────────────────────────────────────────
// MULTI-RESTAURANT CART (Phase 3.5A)
//
// A cart can now hold items from several restaurants. Every item carries an
// AUTHORITATIVE `restaurant` reference resolved server-side from its Menu
// document at add time — the client never supplies the owning restaurant.
//
// buildCartResponse() is the single authoritative shape returned by ALL cart
// endpoints. It groups items by restaurant and prices each group using that
// restaurant's own fields (minOrder, freeDeliveryEnabled, freeDeliveryAbove)
// plus the shared launch delivery tier. The frontend is never responsible for
// authoritative pricing. Delivery shown here is a PREVIEW at the nearest tier
// (real distance is only known once a delivery address is chosen); checkout in
// orderController re-computes the real distance-based fee before any order is
// created.
// ─────────────────────────────────────────────────────────────────────

// Preview delivery fee for the cart, before a delivery address/distance is
// known. Uses the nearest launch tier so the number shown is never higher
// than what checkout will charge. NOT hardcoded per restaurant: the
// free-delivery threshold below comes from the Restaurant document.
const PREVIEW_DELIVERY_FEE = calculateDeliveryFee(0); // = DELIVERY_RULES.UNDER_10_KM

const RESTAURANT_PRICING_FIELDS =
  'name image minOrder freeDeliveryEnabled freeDeliveryAbove isActive availability isOpen';

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Back-fill any legacy cart items that predate item-level restaurant
 * ownership, deriving `restaurant` from the Menu document. Items whose menu
 * no longer exists cannot have an owner derived safely, so they are dropped
 * rather than guessed. Returns true if the cart was mutated (caller saves).
 */
async function backfillItemRestaurants(cart) {
  const missing = cart.items.filter(i => !i.restaurant);
  if (missing.length === 0) return false;

  const ids = [...new Set(missing.map(i => String(i.menuItem)).filter(Boolean))];
  const menus = await MenuItem.find({ _id: { $in: ids } })
    .select('restaurantId name')
    .lean();

  const restaurantIds = [...new Set(menus.map(m => String(m.restaurantId || '')).filter(Boolean))];
  const restaurants = await Restaurant.find({ _id: { $in: restaurantIds } })
    .select('name')
    .lean();
  const restaurantMap = new Map(restaurants.map(r => [String(r._id), r]));

  const map = new Map(menus.map(m => {
    const restId = m.restaurantId || null;
    const rest = restId ? restaurantMap.get(String(restId)) : null;
    const restName = rest?.name || '';
    return [String(m._id), { restId, restName }];
  }));

  let mutated = false;
  const kept = [];
  for (const item of cart.items) {
    if (item.restaurant) { kept.push(item); continue; }
    const resolved = map.get(String(item.menuItem));
    if (resolved && resolved.restId) {
      item.restaurant = resolved.restId;
      if (!item.restaurantName) item.restaurantName = resolved.restName || '';
      kept.push(item);
      mutated = true;
    } else {
      // Menu deleted — do not silently guess an owner; drop the orphan line.
      mutated = true;
    }
  }
  if (mutated) cart.items = kept;
  return mutated;
}

/**
 * Build the authoritative cart response: legacy flat fields (for older
 * frontend/API builds) PLUS grouped-by-restaurant pricing.
 */
async function buildCartResponse(cart) {
  if (!cart) return null;

  // Self-heal legacy carts before pricing.
  const mutated = await backfillItemRestaurants(cart);
  if (mutated) await cart.save();

  const plain = cart.toObject({ virtuals: true });
  const items = Array.isArray(plain.items) ? plain.items : [];

  // Group items by authoritative restaurant, first-seen order.
  const order = [];
  const grouped = new Map();
  for (const item of items) {
    const key = String(item.restaurant);
    if (!grouped.has(key)) { grouped.set(key, []); order.push(key); }
    grouped.get(key).push(item);
  }

  const restaurants = await Restaurant.find({ _id: { $in: order } })
    .select(RESTAURANT_PRICING_FIELDS)
    .lean();
  const restMap = new Map(restaurants.map(r => [String(r._id), r]));

  let foodSubtotal = 0;
  let globalDeliveryFee = 0;
  const groups = order.map(restaurantId => {
    const groupItems = grouped.get(restaurantId);
    const rest = restMap.get(restaurantId) || {};
    const subtotal = round2(groupItems.reduce((s, i) => s + i.price * i.quantity, 0));

    const minimumOrder = Math.max(0, Number(rest.minOrder || 0));
    const minimumOrderMet = subtotal >= minimumOrder;
    const minimumOrderRemaining = minimumOrderMet ? 0 : round2(minimumOrder - subtotal);

    const freeDeliveryEnabled = rest.freeDeliveryEnabled !== false;
    const freeDeliveryAbove = Number(rest.freeDeliveryAbove || 0);
    const freeDeliveryMet = freeDeliveryEnabled && freeDeliveryAbove > 0 && subtotal >= freeDeliveryAbove;
    const deliveryFee = freeDeliveryMet ? 0 : PREVIEW_DELIVERY_FEE;

    const total = round2(subtotal + deliveryFee);
    foodSubtotal += subtotal;
    globalDeliveryFee += deliveryFee;

    return {
      restaurantId,
      restaurantName: rest.name || groupItems[0]?.restaurantName || '',
      restaurantImage: rest.image || '',
      items: groupItems,
      subtotal,
      minimumOrder,
      minimumOrderMet,
      minimumOrderRemaining,
      deliveryFee,
      freeDeliveryEnabled,
      freeDeliveryAbove,
      freeDeliveryMet,
      total,
    };
  });

  foodSubtotal = round2(foodSubtotal);
  globalDeliveryFee = round2(globalDeliveryFee);
  const grandTotal = round2(foodSubtotal + globalDeliveryFee);

  // Legacy top-level restaurant mirrors the FIRST group only.
  const firstGroup = groups[0] || null;

  return {
    _id: plain._id,
    user: plain.user,
    items,
    groups,

    // New authoritative grouped totals
    foodSubtotal,
    deliveryFee: globalDeliveryFee,
    total: grandTotal,

    // Legacy flat fields (kept for backward compatibility)
    subtotal: foodSubtotal,
    restaurant: firstGroup
      ? { _id: firstGroup.restaurantId, name: firstGroup.restaurantName, image: firstGroup.restaurantImage }
      : null,
    restaurantName: firstGroup ? firstGroup.restaurantName : '',

    itemCount: items.reduce((s, i) => s + i.quantity, 0),
    deliveryAddress: plain.deliveryAddress || null,
    paymentMethod: plain.paymentMethod || 'cod',
    updatedAt: plain.updatedAt,
    createdAt: plain.createdAt,
  };
}

// Recompute the legacy top-level restaurant mirror from the current items.
function syncLegacyRestaurant(cart) {
  if (cart.items.length === 0) {
    cart.restaurant = null;
    cart.restaurantName = '';
    return;
  }
  const first = cart.items[0];
  cart.restaurant = first.restaurant || null;
  cart.restaurantName = first.restaurantName || '';
}

// GET /api/cart
const getCart = asyncHandler(async (req, res) => {
  const cart = await Cart.findOne({ user: req.user._id }).populate('deliveryAddress');
  if (!cart) return res.json({ success: true, data: null });
  res.json({ success: true, data: await buildCartResponse(cart) });
});

// POST /api/cart/add
const addToCart = asyncHandler(async (req, res) => {
  const { menuItemId, quantity = 1, customizations = {} } = req.body;

  const menuItem = await MenuItem.findById(menuItemId).select('restaurantId name price originalPrice image isVeg inStock customizations');
  if (!menuItem || menuItem.inStock === false)
    return res.status(404).json({ success: false, message: 'Item not available' });

  // AUTHORITATIVE restaurant resolution — from the Menu document, never the client.
  const ownerRestaurant = menuItem.restaurantId
    ? await Restaurant.findById(menuItem.restaurantId).select('name image isActive availability isOpen')
    : null;
  if (!ownerRestaurant || !ownerRestaurant.isActive || ownerRestaurant.availability?.isOpen === false)
    return res.status(409).json({ success: false, message: 'This restaurant is currently closed.' });

  const requestedQuantity = Number(quantity);
  if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1 || requestedQuantity > 99)
    return res.status(400).json({ success: false, message: 'Quantity must be an integer between 1 and 99.' });

  let cart = await Cart.findOne({ user: req.user._id });
  if (!cart) cart = new Cart({ user: req.user._id });

  await backfillItemRestaurants(cart);

  // Multi-restaurant carts are now ALLOWED. Items from a different restaurant
  // simply form a new group — no rejection.
  const existing = cart.items.find(i => String(i.menuItem) === String(menuItemId));
  if (existing) {
    existing.quantity = Math.min(99, existing.quantity + requestedQuantity);
    // Ensure legacy items gain authoritative ownership too.
    if (!existing.restaurant) existing.restaurant = ownerRestaurant._id;
    if (!existing.restaurantName) existing.restaurantName = ownerRestaurant.name;
  } else {
    cart.items.push({
      menuItem: menuItem._id,
      restaurant: ownerRestaurant._id,          // authoritative
      restaurantName: ownerRestaurant.name,     // snapshot (display only)
      name:     menuItem.name,
      price:    menuItem.price,
      originalPrice: (Number(menuItem.originalPrice) > Number(menuItem.price)) ? Number(menuItem.originalPrice) : null,
      image:    menuItem.image,
      isVeg:    menuItem.isVeg,
      quantity: requestedQuantity,
      customizations,
    });
  }

  syncLegacyRestaurant(cart);
  await cart.save();
  res.json({ success: true, data: await buildCartResponse(cart) });
});

// PUT /api/cart/update
const updateCartItem = asyncHandler(async (req, res) => {
  const { menuItemId, quantity } = req.body;
  const cart = await Cart.findOne({ user: req.user._id });
  if (!cart) return res.status(404).json({ success: false, message: 'Cart not found' });

  await backfillItemRestaurants(cart);

  const idx = cart.items.findIndex(i => String(i.menuItem) === String(menuItemId));
  if (idx === -1) return res.status(404).json({ success: false, message: 'Item not in cart' });

  const q = Number(quantity);
  if (q <= 0) {
    cart.items.splice(idx, 1);
  } else {
    if (!Number.isInteger(q) || q > 99)
      return res.status(400).json({ success: false, message: 'Quantity must be an integer between 1 and 99.' });
    cart.items[idx].quantity = q;
  }

  syncLegacyRestaurant(cart);
  await cart.save();
  res.json({ success: true, data: await buildCartResponse(cart) });
});

// DELETE /api/cart/item/:menuItemId
const removeFromCart = asyncHandler(async (req, res) => {
  const cart = await Cart.findOne({ user: req.user._id });
  if (!cart) return res.status(404).json({ success: false, message: 'Cart not found' });

  await backfillItemRestaurants(cart);
  cart.items = cart.items.filter(i => String(i.menuItem) !== String(req.params.menuItemId));
  syncLegacyRestaurant(cart);

  await cart.save();
  res.json({ success: true, data: await buildCartResponse(cart) });
});

// DELETE /api/cart/clear
const clearCart = asyncHandler(async (req, res) => {
  await Cart.findOneAndUpdate(
    { user: req.user._id },
    { items: [], restaurant: null, restaurantName: '', subtotal: 0, deliveryFee: 0, total: 0 }
  );
  res.json({ success: true, message: 'Cart cleared' });
});

// PATCH /api/cart/address
const setDeliveryAddress = asyncHandler(async (req, res) => {
  const { addressId } = req.body;
  const cart = await Cart.findOneAndUpdate(
    { user: req.user._id },
    { deliveryAddress: addressId },
    { new: true }
  ).populate('deliveryAddress');
  if (!cart) return res.status(404).json({ success: false, message: 'Cart not found' });
  res.json({ success: true, data: await buildCartResponse(cart) });
});

// PATCH /api/cart/payment
const setPaymentMethod = asyncHandler(async (req, res) => {
  const { paymentMethod } = req.body;
  const valid = ['cod'];
  if (!valid.includes(paymentMethod))
    return res.status(400).json({ success: false, message: 'Invalid payment method' });

  const cart = await Cart.findOne({ user: req.user._id });
  if (!cart || cart.items.length === 0)
    return res.status(404).json({ success: false, message: 'Cart is empty' });

  await backfillItemRestaurants(cart);

  // COD must be available for EVERY restaurant represented in the cart.
  const restaurantIds = [...new Set(cart.items.map(i => String(i.restaurant)).filter(Boolean))];
  const restaurants = await Restaurant.find({ _id: { $in: restaurantIds } })
    .select('codEnabled isActive name');

  if (restaurants.length !== restaurantIds.length)
    return res.status(404).json({ success: false, message: 'One or more restaurants in your cart are unavailable.' });

  if (paymentMethod === 'cod') {
    const noCod = restaurants.find(r => !r.isActive || r.codEnabled !== true);
    if (noCod)
      return res.status(403).json({
        success: false,
        message: `Cash on Delivery is not available for ${noCod.name || 'one of the restaurants'} in your cart.`,
      });
  }

  cart.paymentMethod = paymentMethod;
  await cart.save();
  res.json({ success: true, data: await buildCartResponse(cart) });
});

module.exports = {
  getCart,
  addToCart,
  updateCartItem,
  removeFromCart,
  clearCart,
  setDeliveryAddress,
  setPaymentMethod,
  // exported for tests / reuse
  buildCartResponse,
};

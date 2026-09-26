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
 * Resolve, validate, and PRICE a customer's customization choices against the
 * item's own customization groups. Prices come from the Menu document, never
 * the client, so a tampered request can't lower the price. Enforces each
 * group's required / minSelect / maxSelect rules.
 *
 * Client sends: customizations = [ { title, selected: ["label", ...] } ]
 *   (also tolerates { title, options: [{label}] }).
 * Returns { resolved:[{title,options:[{label,extraPrice,isVeg}]}], extra, error }.
 */
function resolveCustomizations(menuItem, raw) {
  const groups = Array.isArray(menuItem.customizations) ? menuItem.customizations : [];
  if (!groups.length) return { resolved: [], extra: 0, error: null };

  const picked = {};
  const arr = Array.isArray(raw) ? raw : [];
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const title = String(entry.title || '');
    let labels = [];
    if (Array.isArray(entry.selected)) labels = entry.selected.map(String);
    else if (Array.isArray(entry.options)) labels = entry.options.map(o => String(o && o.label != null ? o.label : o));
    picked[title] = labels;
  }

  let extra = 0;
  const resolved = [];
  for (const g of groups) {
    const title = String(g.title || '');
    const opts = Array.isArray(g.options) ? g.options : [];
    const min = g.required ? Math.max(1, Number(g.minSelect || 1)) : Number(g.minSelect || 0);
    const max = Number(g.maxSelect || 1) || 1;
    const chosenLabels = picked[title] || [];

    if (chosenLabels.length < min)
      return { error: `Please choose ${min > 1 ? min + ' options' : 'an option'} for "${title}".` };
    if (chosenLabels.length > max)
      return { error: `You can select up to ${max} for "${title}".` };

    const chosen = [];
    for (const lbl of chosenLabels) {
      const opt = opts.find(o => String(o.label) === String(lbl));
      if (!opt) return { error: `"${lbl}" isn't a valid choice for "${title}".` };
      const p = Number(opt.extraPrice || 0);
      extra += p;
      chosen.push({ label: opt.label, extraPrice: p, isVeg: opt.isVeg !== false });
    }
    if (chosen.length) resolved.push({ title, options: chosen });
  }
  return { resolved, extra: round2(extra), error: null };
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

// Distinct item-level restaurant ids, first-seen order (same keys the
// grouping below produces from the plain items).
function groupRestaurantIds(items) {
  const ids = [];
  const seen = new Set();
  for (const item of items || []) {
    const key = String(item.restaurant);
    if (!seen.has(key)) { seen.add(key); ids.push(key); }
  }
  return ids;
}

// Current pricing fields for the given restaurants. Always read from MongoDB
// (never from the client and never cached across requests).
function fetchPricingRestaurants(restaurantIds) {
  if (!restaurantIds.length) return Promise.resolve([]);
  return Restaurant.find({ _id: { $in: restaurantIds } })
    .select(RESTAURANT_PRICING_FIELDS)
    .lean()
    .exec();
}

// `prefetched` = { ids, rows } fetched earlier IN THE SAME REQUEST (e.g. in
// parallel with cart.save()). Any id it does not cover is fetched now.
async function loadPricingRestaurants(restaurantIds, prefetched) {
  if (!restaurantIds.length) return [];
  if (!prefetched) return fetchPricingRestaurants(restaurantIds);
  const known = new Set(prefetched.ids);
  const missing = restaurantIds.filter(id => !known.has(id));
  if (!missing.length) return prefetched.rows;
  return prefetched.rows.concat(await fetchPricingRestaurants(missing));
}

/**
 * Build the authoritative cart response: legacy flat fields (for older
 * frontend/API builds) PLUS grouped-by-restaurant pricing.
 *
 * options (all optional, backward compatible with buildCartResponse(cart)):
 *   populateAddress        — populate deliveryAddress here, in parallel with
 *                            the restaurant pricing read (used by GET /cart).
 *   prefetchedRestaurants  — { ids, rows } already read in this request.
 */
async function buildCartResponse(cart, options = {}) {
  if (!cart) return null;

  // Self-heal legacy carts before pricing.
  const mutated = await backfillItemRestaurants(cart);
  if (mutated) await cart.save();

  // PERFORMANCE: the restaurant pricing read and the delivery-address
  // populate are independent, so they run together (one round trip, not two).
  // An empty cart no longer issues a Restaurant query that cannot match.
  const [restaurants] = await Promise.all([
    loadPricingRestaurants(groupRestaurantIds(cart.items), options.prefetchedRestaurants),
    options.populateAddress && cart.deliveryAddress
      ? Cart.populate(cart, { path: 'deliveryAddress' })
      : null,
  ]);

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

    const freeDeliveryEnabled = Number(rest.freeDeliveryAbove || 0) > 0;
    const freeDeliveryAbove = Number(rest.freeDeliveryAbove || 0);
    const freeDeliveryMet = freeDeliveryAbove > 0 && subtotal >= freeDeliveryAbove;
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
    paymentMethod: plain.paymentMethod === 'cod' ? 'upi' : (plain.paymentMethod || 'upi'),
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
  // deliveryAddress is populated inside buildCartResponse, in parallel with
  // the restaurant pricing read (was: cart -> address -> restaurants, now:
  // cart -> [address + restaurants]). Response is unchanged.
  const cart = await Cart.findOne({ user: req.user._id });
  if (!cart) return res.json({ success: true, data: null });
  res.json({ success: true, data: await buildCartResponse(cart, { populateAddress: true }) });
});

// POST /api/cart/add
const addToCart = asyncHandler(async (req, res) => {
  const { menuItemId, quantity = 1, customizations = {} } = req.body;

  const menuItem = await MenuItem.findById(menuItemId).select('restaurantId name price originalPrice image isVeg inStock customizations');
  if (!menuItem || menuItem.inStock === false)
    return res.status(404).json({ success: false, message: 'Item not available' });

  // PERFORMANCE: the user's cart does not depend on the restaurant lookup, so
  // it is read in parallel with it. It is still only USED after every
  // validation below has passed, in the same order as before (an unused read
  // on a rejected request is simply discarded).
  const cartPromise = Cart.findOne({ user: req.user._id }).exec();
  cartPromise.catch(() => {}); // surfaced when awaited below, not as an unhandled rejection

  // AUTHORITATIVE restaurant resolution — from the Menu document, never the client.
  const ownerRestaurant = menuItem.restaurantId
    ? await Restaurant.findById(menuItem.restaurantId).select('name image isActive availability isOpen')
    : null;
  if (!ownerRestaurant || !ownerRestaurant.isActive || ownerRestaurant.availability?.isOpen === false)
    return res.status(409).json({ success: false, message: 'This restaurant is currently closed.' });

  const requestedQuantity = Number(quantity);
  if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1 || requestedQuantity > 99)
    return res.status(400).json({ success: false, message: 'Quantity must be an integer between 1 and 99.' });

  let cart = await cartPromise;
  if (!cart) cart = new Cart({ user: req.user._id });

  await backfillItemRestaurants(cart);

  // Multi-restaurant carts are now ALLOWED. Items from a different restaurant
  // simply form a new group — no rejection.
  const { resolved, extra, error } = resolveCustomizations(menuItem, customizations);
  if (error) return res.status(400).json({ success: false, message: error });
  const unitPrice = round2(Number(menuItem.price) + extra);
  const sig = JSON.stringify(resolved);

  // Same item + same customizations merges; a differently-customized item
  // forms its own line (a plain pizza and a loaded pizza are separate entries).
  const existing = cart.items.find(i =>
    String(i.menuItem) === String(menuItemId) &&
    JSON.stringify(Array.isArray(i.customizations) ? i.customizations : []) === sig
  );
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
      price:    unitPrice,                       // base + priced customizations
      originalPrice: (Number(menuItem.originalPrice) > Number(menuItem.price)) ? round2(Number(menuItem.originalPrice) + extra) : null,
      image:    menuItem.image,
      isVeg:    menuItem.isVeg,
      quantity: requestedQuantity,
      customizations: resolved,
    });
  }

  syncLegacyRestaurant(cart);

  // PERFORMANCE: read the current pricing fields of every restaurant in the
  // cart while the cart is being saved (one round trip instead of two). The
  // group set cannot change during save(), and prices/ownership were already
  // resolved from the Menu + Restaurant documents above.
  const pricingIds = groupRestaurantIds(cart.items);
  const [, pricingRows] = await Promise.all([
    cart.save(),
    fetchPricingRestaurants(pricingIds),
  ]);
  res.json({
    success: true,
    data: await buildCartResponse(cart, { prefetchedRestaurants: { ids: pricingIds, rows: pricingRows } }),
  });
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
  if (!mongoose.Types.ObjectId.isValid(addressId)) {
    return res.status(400).json({ success: false, message: 'A valid addressId is required.' });
  }

  // Never allow a customer to attach or read another customer's saved address.
  const ownedAddress = await require('../models/Address').findOne({
    _id: addressId,
    user: req.user._id,
  }).lean();
  if (!ownedAddress) {
    return res.status(404).json({ success: false, message: 'Address not found on your account.' });
  }

  const cart = await Cart.findOneAndUpdate(
    { user: req.user._id },
    { deliveryAddress: ownedAddress._id },
    { new: true }
  ).populate('deliveryAddress');
  if (!cart) return res.status(404).json({ success: false, message: 'Cart not found' });
  res.json({ success: true, data: await buildCartResponse(cart) });
});

// PATCH /api/cart/payment
const setPaymentMethod = asyncHandler(async (req, res) => {
  const { paymentMethod } = req.body;
  if (paymentMethod !== 'upi') {
    return res.status(400).json({
      success: false,
      message: 'Only UPI online payment is available. Cash on Delivery is disabled.',
    });
  }

  const cart = await Cart.findOne({ user: req.user._id });
  if (!cart || cart.items.length === 0)
    return res.status(404).json({ success: false, message: 'Cart is empty' });

  await backfillItemRestaurants(cart);
  cart.paymentMethod = 'upi';
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

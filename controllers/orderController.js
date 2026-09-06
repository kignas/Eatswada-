// File 2: controllers/orderController.js
const mongoose    = require('mongoose');
const Order      = require('../models/Order');
const Cart       = require('../models/Cart');
const Address    = require('../models/Address');
const Restaurant = require('../models/Restaurant');
const Menu       = require('../models/Menu');
const User       = require('../models/User');
const Review     = require('../models/Review');
const asyncHandler = require('express-async-handler');
const { autoAssignRider, scheduleRiderTimeout } = require('../services/riderAssignmentService');
const {
  getMenuRefId,
  groupItemsByRestaurant,
  allocateTip,
  resolveRestaurantNote,
  normalizeRestaurantNotes,
} = require('../services/checkoutMath');

// ── Live-data population for order responses ────────────────────────
// Orders store a *snapshot* of the restaurant name/image and each item's
// image at checkout time (denormalized for speed/history). That snapshot
// is what was going stale: it never changes even after a vendor renames
// their restaurant or swaps a dish photo. These paths pull the current
// Restaurant/Menu documents alongside the order so the API can prefer
// live data over the frozen snapshot.
const ORDER_POPULATE_PATHS = [
  {
    path: 'restaurant',
    select: 'name image address owner',
    populate: {
      path: 'owner',
      select: 'name phone',
    },
  },
  { path: 'items.menuItem', select: 'image' },
];

/**
 * Build the JSON an order response should send: live restaurant name/logo
 * and live per-item image where available, falling back to the snapshot
 * stored on the order itself when the referenced document is missing
 * (soft-deleted restaurant, deleted menu item, or a legacy order created
 * before these refs existed) — old orders keep rendering exactly as
 * before, and nothing here is ever a hardcoded name or image.
 */
function withLiveDisplayData(orderDoc) {
  const order = orderDoc.toObject({ virtuals: false });

  // Public identifiers are intentionally exposed explicitly so customer,
  // admin/vendor and rider UIs can display the same production-style IDs.
  // MongoDB _id remains available internally and is NOT replaced.
  order.publicOrderId = order.orderNumber || '';
  order.publicShipmentId = order.shipmentId || '';

  if (order.restaurant && typeof order.restaurant === 'object') {
    const liveRestaurant = order.restaurant;

    order.restaurantName = liveRestaurant.name || order.restaurantName;
    order.restaurantImage = liveRestaurant.image || order.restaurantImage;

    // Keep the existing `restaurant` field as an id for backward compatibility,
    // but expose the live restaurant contact details separately for customer
    // tracking and support actions.
    order.restaurantAddress = liveRestaurant.address || '';
    order.restaurantPhone = liveRestaurant.owner?.phone || liveRestaurant.phone || '';
    order.restaurantOwnerName = liveRestaurant.owner?.name || '';

    order.restaurant = liveRestaurant._id;
  }

  if (Array.isArray(order.items)) {
    order.items = order.items.map((item) => {
      const liveMenuItem = item.menuItem && typeof item.menuItem === 'object' ? item.menuItem : null;
      return {
        ...item,
        image: (liveMenuItem && liveMenuItem.image) || item.image || '',
        menuItem: liveMenuItem ? liveMenuItem._id : item.menuItem,
      };
    });
  }

  return order;
}


// ─────────────────────────────────────────────────────────────────────
// Server-authoritative delivery + order pricing
// Maynaguri launch rule:
//   < 10 km   => ₹30
//   10–15 km  => ₹40
//   > 15 km   => ₹50
// The browser may display an estimate, but these values are calculated
// again here from database data and customer coordinates.
// ─────────────────────────────────────────────────────────────────────
const DELIVERY_RULES = Object.freeze({
  UNDER_10_KM: 30,
  FROM_10_TO_15_KM: 40,
  ABOVE_15_KM: 50,
});
const MAX_DELIVERY_RADIUS_KM = 15;
// Customer tip is optional, but must stay within a sane server-side limit.
const MAX_TIP_AMOUNT = 500;

function validCoordinates(coords) {
  return Array.isArray(coords) &&
    coords.length === 2 &&
    Number.isFinite(Number(coords[0])) &&
    Number.isFinite(Number(coords[1])) &&
    Number(coords[0]) >= -180 && Number(coords[0]) <= 180 &&
    Number(coords[1]) >= -90 && Number(coords[1]) <= 90;
}

function isPlaceholderRestaurantLocation(coords) {
  // Restaurant.js currently has Kolkata as a legacy placeholder default.
  // Nearbite launches in Maynaguri, so never use that placeholder for pricing.
  return Array.isArray(coords) &&
    Math.abs(Number(coords[0]) - 88.3832) < 0.000001 &&
    Math.abs(Number(coords[1]) - 22.5726) < 0.000001;
}

function haversineKm(from, to) {
  const [lon1, lat1] = from.map(Number);
  const [lon2, lat2] = to.map(Number);
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calculateDeliveryFee(distanceKm) {
  if (distanceKm < 10) return DELIVERY_RULES.UNDER_10_KM;
  if (distanceKm <= 15) return DELIVERY_RULES.FROM_10_TO_15_KM;
  return DELIVERY_RULES.ABOVE_15_KM;
}

function normalizeCustomerCoordinates(deliveryAddress) {
  if (!deliveryAddress || typeof deliveryAddress !== 'object') return null;

  if (validCoordinates(deliveryAddress.coordinates)) {
    return [Number(deliveryAddress.coordinates[0]), Number(deliveryAddress.coordinates[1])];
  }

  // Support the address.html version currently saving latitude/longitude.
  if (Number.isFinite(Number(deliveryAddress.longitude)) &&
      Number.isFinite(Number(deliveryAddress.latitude))) {
    return [Number(deliveryAddress.longitude), Number(deliveryAddress.latitude)];
  }

  // Also accept a nested GeoJSON-style location from future address UI.
  if (deliveryAddress.location && validCoordinates(deliveryAddress.location.coordinates)) {
    return [
      Number(deliveryAddress.location.coordinates[0]),
      Number(deliveryAddress.location.coordinates[1]),
    ];
  }

  return null;
}

function normalizeCustomizationSelection(selection) {
  if (!selection || typeof selection !== 'object') return [];
  const values = Array.isArray(selection)
    ? selection
    : Object.values(selection);
  return values.map(value => {
    if (typeof value === 'string') return value;
    return value?.label || value?.value || value?.name || '';
  }).filter(Boolean);
}

function calculateItemServerPrice(menuItem, requestedCustomizations) {
  let price = Number(menuItem.price);

  // Only add customization prices that actually exist on the Menu document.
  // This prevents a client from inventing an extraPrice.
  const selectedLabels = new Set(normalizeCustomizationSelection(requestedCustomizations));

  if (selectedLabels.size && Array.isArray(menuItem.customizations)) {
    for (const group of menuItem.customizations) {
      for (const option of (group.options || [])) {
        if (selectedLabels.has(option.label)) {
          price += Number(option.extraPrice || 0);
        }
      }
    }
  }

  return price;
}

// Resolves which delivery address/coordinates an order should use.
//
// Preferred path: addressId points at a saved Address document owned by
// this user — its stored GPS coordinates are used, NOT anything the client
// claims in deliveryAddress.location/coordinates. This closes a gap where
// a client could previously submit arbitrary coordinates in deliveryAddress
// to influence the distance-based fee.
//
// Fallback path (addressId absent): the legacy deliveryAddress object the
// client sends directly. Kept only for backward compatibility with older
// app builds that predate addressId support — coordinates on this path are
// NOT verified against any saved address.
async function resolveDeliveryAddress({ addressId, deliveryAddress, userId }) {
  if (addressId) {
    if (!mongoose.Types.ObjectId.isValid(addressId)) {
      const error = new Error('Invalid delivery address selected.');
      error.statusCode = 400;
      throw error;
    }

    const addressDoc = await Address.findOne({ _id: addressId, user: userId }).lean();
    if (!addressDoc) {
      const error = new Error('Selected delivery address was not found on your account.');
      error.statusCode = 404;
      throw error;
    }

    const coords = validCoordinates(addressDoc.location?.coordinates)
      ? [Number(addressDoc.location.coordinates[0]), Number(addressDoc.location.coordinates[1])]
      : null;

    return {
      coords,
      snapshot: {
        tag: addressDoc.tag || 'Home',
        house: addressDoc.house || '',
        area: addressDoc.area || '',
        landmark: addressDoc.landmark || '',
        city: addressDoc.city || 'Maynaguri',
        pincode: addressDoc.pincode || '',
      },
    };
  }

  return {
    coords: normalizeCustomerCoordinates(deliveryAddress),
    snapshot: {
      tag: deliveryAddress?.tag || 'Home',
      house: deliveryAddress?.house || '',
      area: deliveryAddress?.area || '',
      landmark: deliveryAddress?.landmark || '',
      city: deliveryAddress?.city || 'Maynaguri',
      pincode: deliveryAddress?.pincode || '',
    },
  };
}

// Price a SINGLE restaurant's slice of a (possibly multi-restaurant) cart.
// Customer coordinates + delivery address are resolved ONCE by the caller and
// shared across every restaurant in the checkout. Throws (with .statusCode)
// on any failure so the WHOLE checkout is rejected before a single order is
// written — a customer never ends up with a partial multi-restaurant order.
async function buildRestaurantPricing({ restaurantId, items, customerCoords }) {
  if (!mongoose.Types.ObjectId.isValid(restaurantId)) {
    const error = new Error('Invalid restaurant'); error.statusCode = 400; throw error;
  }

  const restaurant = await Restaurant.findOne({ _id: restaurantId, isActive: true })
    .select('name image owner location availability isOpen deliveryRadiusKm minOrder freeDeliveryEnabled freeDeliveryAbove codEnabled');
  if (!restaurant) { const e = new Error('Restaurant not found or unavailable'); e.statusCode = 404; throw e; }

  if (restaurant.availability?.isOpen === false || restaurant.isOpen === false) {
    const e = new Error(`${restaurant.name} is currently closed and is not accepting orders.`); e.statusCode = 409; throw e;
  }

  const restaurantCoords = restaurant.location?.coordinates;
  if (!validCoordinates(restaurantCoords) || isPlaceholderRestaurantLocation(restaurantCoords)) {
    const e = new Error(`${restaurant.name} does not have a verified map location yet. Please try another restaurant.`);
    e.statusCode = 409; throw e;
  }

  const distanceKm = haversineKm(restaurantCoords, customerCoords);
  const configuredRadius = Number(restaurant.deliveryRadiusKm);
  const effectiveRadius = Number.isFinite(configuredRadius) && configuredRadius > 0
    ? Math.min(configuredRadius, MAX_DELIVERY_RADIUS_KM)
    : MAX_DELIVERY_RADIUS_KM;
  if (distanceKm > effectiveRadius) {
    const e = new Error(`${restaurant.name} delivers only within ${effectiveRadius.toFixed(1).replace(/\.0$/, '')} km — your address is ${distanceKm.toFixed(1)} km away.`);
    e.statusCode = 400; throw e;
  }

  const menuIds = items.map(it => it?.menuItem || it?.menuId || it?.id || it?._id);
  if (menuIds.some(id => !mongoose.Types.ObjectId.isValid(id))) {
    const e = new Error('One or more cart items are invalid or outdated. Please refresh your cart.'); e.statusCode = 400; throw e;
  }
  const uniqueIds = [...new Set(menuIds.map(String))];
  const menuDocs = await Menu.find({ _id: { $in: uniqueIds }, restaurantId: restaurant._id }).lean();
  const menuMap = new Map(menuDocs.map(m => [String(m._id), m]));

  const serverItems = [];
  let subtotal = 0;
  for (const requested of items) {
    const rawId = requested?.menuItem || requested?.menuId || requested?.id || requested?._id;
    const menuItem = menuMap.get(String(rawId));
    if (!menuItem) { const e = new Error('A cart item no longer belongs to this restaurant. Please refresh your cart.'); e.statusCode = 409; throw e; }
    if (menuItem.inStock === false) { const e = new Error(`${menuItem.name} is currently out of stock.`); e.statusCode = 409; throw e; }
    const quantity = Number(requested.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) { const e = new Error(`Invalid quantity for ${menuItem.name}.`); e.statusCode = 400; throw e; }
    const unitPrice = calculateItemServerPrice(menuItem, requested.customizations);
    subtotal += unitPrice * quantity;
    serverItems.push({
      menuItem: menuItem._id,
      name: menuItem.name,
      price: unitPrice,
      originalPrice: (Number(menuItem.originalPrice) > Number(menuItem.price)) ? Number(menuItem.originalPrice) : null,
      image: menuItem.image || '',
      isVeg: !!menuItem.isVeg,
      quantity,
      customizations: requested.customizations || {},
    });
  }

  // Per-restaurant minimum order.
  const minimumOrder = Number(restaurant.minOrder || 0);
  if (minimumOrder > 0 && subtotal < minimumOrder) {
    const e = new Error(`Minimum order for ${restaurant.name} is ₹${minimumOrder}. Add ₹${Math.ceil(minimumOrder - subtotal)} more to continue.`);
    e.statusCode = 400; throw e;
  }

  // Per-restaurant delivery fee + per-restaurant free-delivery threshold.
  const baseDeliveryFee = calculateDeliveryFee(distanceKm);
  const freeDeliveryEnabled = restaurant.freeDeliveryEnabled !== false;
  const freeDeliveryAbove = Number(restaurant.freeDeliveryAbove || 0);
  const deliveryFee = freeDeliveryEnabled && freeDeliveryAbove > 0 && subtotal >= freeDeliveryAbove
    ? 0
    : baseDeliveryFee;

  return { restaurant, serverItems, subtotal, deliveryFee, distanceKm: Number(distanceKm.toFixed(2)) };
}

// Shapes the checkout response. A SINGLE-restaurant checkout keeps the EXACT
// legacy shape ({ data: order, deliveryOtp }) so existing clients that redirect
// to track-order.html?id=data._id keep working unchanged. A multi-restaurant
// checkout additionally returns { multiple:true, orders:[...], deliveryOtps }.
function buildCheckoutResponse(orders, replay) {
  const shaped = orders.map(o => {
    const otp = replay ? (o.deliveryOtp || '') : (o._capturedOtp || '');
    return {
      order: {
        ...withLiveDisplayData(o),
        orderNumber: o.orderNumber,
        shipmentId: o.shipmentId,
        publicOrderId: o.orderNumber,
        publicShipmentId: o.shipmentId,
        deliveryDistanceKm: o.deliveryDistanceKm,
      },
      deliveryOtp: otp,
    };
  });

  if (shaped.length === 1) {
    return { success: true, replay: !!replay, data: shaped[0].order, deliveryOtp: shaped[0].deliveryOtp };
  }

  return {
    success: true,
    replay: !!replay,
    multiple: true,
    count: shaped.length,
    data: shaped[0].order, // backward-compatible primary order
    orders: shaped.map(s => s.order),
    deliveryOtps: shaped.reduce((acc, s) => { acc[s.order._id] = s.deliveryOtp; return acc; }, {}),
  };
}

const createOrder = asyncHandler(async (req, res) => {
  const {
    items,
    deliveryAddress,
    addressId,
    paymentMethod = 'cod',
    restaurantNote,
    restaurantNotes,
    globalNote,
    deliveryInstructions,
    tipAmount = 0,
  } = req.body;

  const validPaymentMethods = ['upi', 'card', 'wallet', 'cod'];
  if (!validPaymentMethods.includes(paymentMethod)) {
    const e = new Error('Invalid payment method.'); e.statusCode = 400; throw e;
  }
  if (!Array.isArray(items) || items.length === 0) {
    const e = new Error('Cart is empty'); e.statusCode = 400; throw e;
  }

  // ── Idempotency ─────────────────────────────────────────────────────
  // A client may retry (double-tap, dropped response, network retry). When it
  // sends the same key, return the orders already created for that key instead
  // of creating a second set. Covers the whole checkout (possibly several
  // restaurant orders). NOTE: this closes sequential retries; the frontend
  // button-lock covers the rarer truly-concurrent double POST.
  const idempotencyKey = String(req.headers['idempotency-key'] || req.body.idempotencyKey || '').trim().slice(0, 100);
  if (idempotencyKey) {
    const existing = await Order.find({ user: req.user._id, idempotencyKey })
      .select('+deliveryOtp')
      .populate(ORDER_POPULATE_PATHS)
      .sort({ createdAt: 1 });
    if (existing.length) {
      return res.status(200).json(buildCheckoutResponse(existing, true));
    }
  }

  // ── Resolve the ONE delivery address for the whole checkout ─────────
  const { coords: customerCoords, snapshot: addressSnapshot } =
    await resolveDeliveryAddress({ addressId, deliveryAddress, userId: req.user._id });
  if (!customerCoords) {
    const e = new Error('Please select your delivery location using GPS/Google Maps before placing the order.');
    e.statusCode = 400; throw e;
  }

  // ── Tip: validate the TOTAL once (server-authoritative) ─────────────
  const parsedTip = Number(tipAmount ?? 0);
  if (!Number.isFinite(parsedTip) || parsedTip < 0 || parsedTip > MAX_TIP_AMOUNT) {
    const e = new Error(`Tip must be between ₹0 and ₹${MAX_TIP_AMOUNT}.`); e.statusCode = 400; throw e;
  }
  const totalTip = Math.round(parsedTip * 100) / 100;

  // ── Group items by the REAL restaurant that owns each menu item ─────
  // The client's restaurantId is NEVER trusted for grouping — checkoutMath
  // regroups from a menuId->restaurantId map resolved from MongoDB.
  const allMenuIds = items
    .map(getMenuRefId)
    .filter(id => mongoose.Types.ObjectId.isValid(id))
    .map(String);
  const ownerDocs = await Menu.find({ _id: { $in: [...new Set(allMenuIds)] } }).select('restaurantId').lean();
  const menuRestaurantMap = new Map(ownerDocs.map(m => [String(m._id), String(m.restaurantId)]));
  const groups = groupItemsByRestaurant(items, menuRestaurantMap); // throws 400 on any unknown item

  // ── Price EVERY restaurant before creating anything ─────────────────
  const priced = [];
  for (const group of groups) {
    priced.push(await buildRestaurantPricing({
      restaurantId: group.restaurantId,
      items: group.items,
      customerCoords,
    }));
  }

  // COD availability is per restaurant.
  if (paymentMethod === 'cod') {
    const noCod = priced.find(p => p.restaurant.codEnabled !== true);
    if (noCod) { const e = new Error(`Cash on Delivery is not available for ${noCod.restaurant.name}.`); e.statusCode = 403; throw e; }
  }

  // Split the tip across restaurants by delivery fee (never duplicated).
  const tipShares = allocateTip(totalTip, priced.map(p => p.deliveryFee));

  const isSingle = priced.length === 1;
  const customer = await User.findById(req.user._id).select('name phone').lean();
  const perRestaurantNotes = normalizeRestaurantNotes(restaurantNotes, mongoose.Types.ObjectId.isValid);
  const sharedDeliveryInstructions = typeof deliveryInstructions === 'string'
    ? deliveryInstructions.trim().slice(0, 250) : '';

  // ── Create one order per restaurant ─────────────────────────────────
  const created = [];
  for (let i = 0; i < priced.length; i += 1) {
    const p = priced[i];
    const note = resolveRestaurantNote({
      restaurantId: String(p.restaurant._id),
      perRestaurantNotes,
      flatNote: restaurantNote,
      isSingleRestaurant: isSingle,
      globalNote: globalNote === true,
    });
    const tip = tipShares[i] || 0;

    const order = await Order.create({
      user: req.user._id,
      restaurant: p.restaurant._id,
      restaurantName: p.restaurant.name,
      restaurantImage: p.restaurant.image || '',
      customerName: customer?.name || '',
      customerPhone: customer?.phone || '',
      items: p.serverItems,
      deliveryAddress: { ...addressSnapshot, coordinates: customerCoords },
      deliveryDistanceKm: p.distanceKm,
      subtotal: p.subtotal,
      deliveryFee: p.deliveryFee,
      restaurantNote: note,
      deliveryInstructions: sharedDeliveryInstructions,
      tipAmount: tip,
      total: p.subtotal + p.deliveryFee + tip,
      paymentMethod,
      paymentStatus: 'pending',
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    order._capturedOtp = order._plainDeliveryOtp;
    order.clearOtpSecrets();
    await order.populate(ORDER_POPULATE_PATHS);
    created.push(order);
  }

  await Cart.findOneAndUpdate(
    { user: req.user._id },
    { $set: { items: [], restaurant: null, restaurantName: '', subtotal: 0, deliveryFee: 0, total: 0, paymentMethod: 'cod' } }
  );

  return res.status(201).json(buildCheckoutResponse(created, false));
});

const getOrders = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 10 } = req.query;
  const filter = { user: req.user._id };
  if (status) filter.status = status;

  const skip = (Number(page) - 1) * Number(limit);
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .select('+deliveryOtp')
      .populate(ORDER_POPULATE_PATHS)
      .populate('rider', 'name phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    Order.countDocuments(filter),
  ]);

  res.json({
    success: true,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
    total,
    data: orders.map(withLiveDisplayData),
  });
});

const getOrderById = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, user: req.user._id })
    .select('+deliveryOtp')
    .populate(ORDER_POPULATE_PATHS)
    .populate('rider', 'name phone');
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  res.json({ success: true, data: withLiveDisplayData(order) });
});

const cancelOrder = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

  // A customer may cancel ONLY while the order is still 'placed' — i.e. before
  // the restaurant has accepted it. Once accepted (confirmed) and preparing has
  // begun, the customer can no longer cancel from here.
  if (order.status !== 'placed') {
    const message = order.status === 'cancelled'
      ? 'This order is already cancelled.'
      : 'This order has already been accepted by the restaurant and can no longer be cancelled. Please contact support if you need help.';
    return res.status(409).json({ success: false, message });
  }

  order.advanceStatus('cancelled', req.body.reason || 'Cancelled by customer');
  order.cancelReason = req.body.reason || 'Cancelled by customer';
  await order.save();
  await order.populate(ORDER_POPULATE_PATHS);

  res.json({ success: true, message: 'Order cancelled', data: withLiveDisplayData(order) });
});

async function refreshRestaurantRating(restaurantId) {
  const result = await Review.aggregate([
    { $match: { restaurant: restaurantId, isVisible: true } },
    { $group: { _id: null, avg: { $avg: '$score' }, count: { $sum: 1 } } }
  ]);
  const stats = result[0] || { avg: 0, count: 0 };
  await Restaurant.findByIdAndUpdate(restaurantId, {
    rating: stats.count ? Math.round(stats.avg * 10) / 10 : 4,
    ratingCount: stats.count,
    reviewCount: stats.count,
  });
  return stats;
}

const getOrderReview = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, user: req.user._id }).select('_id status restaurant');
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  const review = await Review.findOne({ order: order._id });
  res.json({ success: true, data: review || null });
});

const submitReview = asyncHandler(async (req, res) => {
  const { score, riderScore, comment = '' } = req.body;
  const numericScore = Number(score);
  const numericRiderScore = riderScore == null || riderScore === '' ? null : Number(riderScore);
  if (!Number.isInteger(numericScore) || numericScore < 1 || numericScore > 5)
    return res.status(400).json({ success: false, message: 'Restaurant rating must be a whole number from 1 to 5.' });
  if (numericRiderScore !== null && (!Number.isInteger(numericRiderScore) || numericRiderScore < 1 || numericRiderScore > 5))
    return res.status(400).json({ success: false, message: 'Rider rating must be a whole number from 1 to 5.' });

  const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  if (order.status !== 'delivered') return res.status(400).json({ success: false, message: 'You can only review delivered orders.' });

  const cleanComment = String(comment || '').trim().slice(0, 500);
  let review = await Review.findOne({ order: order._id });
  const wasNewReview = !review;
  if (review && String(review.user) !== String(req.user._id)) return res.status(403).json({ success: false, message: 'Not authorized.' });

  if (review) {
    review.score = numericScore;
    review.riderScore = numericRiderScore;
    review.comment = cleanComment;
    review.isVisible = true;
    review.adminNote = '';
  } else {
    review = new Review({ restaurant: order.restaurant, user: req.user._id, order: order._id, score: numericScore, riderScore: numericRiderScore, comment: cleanComment });
  }
  await review.save();

  // Keep the existing order rating field for backwards compatibility with old order/tracking UI.
  order.rating = { score: numericScore, comment: cleanComment, givenAt: new Date() };
  await order.save();
  const stats = await refreshRestaurantRating(order.restaurant);

  res.status(wasNewReview ? 201 : 200).json({
    success: true,
    message: wasNewReview ? 'Review submitted successfully.' : 'Review updated successfully.',
    data: review,
    restaurantRating: { rating: stats.count ? Math.round(stats.avg * 10) / 10 : 4, ratingCount: stats.count }
  });
});

// Backward-compatible alias for the old /rate endpoint.
const rateOrder = submitReview;

const VENDOR_SETTABLE_STATUSES = ['confirmed', 'preparing', 'waiting_for_rider', 'delivered', 'cancelled'];

const FORWARD_TRANSITIONS = {
  placed:             ['confirmed'],
  confirmed:          ['preparing'],
  preparing:          ['waiting_for_rider'],
  waiting_for_rider:  [], 
  assigned:           [], 
  out_for_delivery:   ['delivered'],
  otp_verified:       ['delivered'],
  delivered:          [], 
  cancelled:          [], 
};

const CANCELLABLE_FROM = ['placed', 'confirmed', 'preparing', 'waiting_for_rider', 'assigned', 'out_for_delivery', 'otp_verified'];

function allowedNextStatuses(currentStatus) {
  const forward = FORWARD_TRANSITIONS[currentStatus] || [];
  return CANCELLABLE_FROM.includes(currentStatus) ? [...forward, 'cancelled'] : forward;
}

const updateOrderStatus = asyncHandler(async (req, res) => {
  const { status, note } = req.body;
  if (!VENDOR_SETTABLE_STATUSES.includes(status))
    return res.status(400).json({ success: false, message: 'Invalid status' });

  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

  const allowed = allowedNextStatuses(order.status);
  if (!allowed.includes(status)) {
    return res.status(409).json({
      success: false,
      message: allowed.length
        ? `Cannot move order from "${order.status}" to "${status}". Allowed next status: ${allowed.join(', ')}.`
        : `Cannot update order — it is currently "${order.status}", which cannot be changed from this endpoint.`,
    });
  }

  if (status === 'delivered' && !order.deliveryOtpVerified) {
    return res.status(409).json({
      success: false,
      message: 'Cannot mark this order as delivered until the delivery OTP has been verified.',
    });
  }

  order.advanceStatus(status, note || '');

  let riderAssignment = null;
  if (status === 'waiting_for_rider' && !order.rider) {
    riderAssignment = await autoAssignRider(order); 
  }

  await order.save();
  await order.populate(ORDER_POPULATE_PATHS);

  // If auto-assigned successfully, schedule the 60-second acceptance timeout check
  if (riderAssignment && riderAssignment.assigned) {
    scheduleRiderTimeout(order._id, order.rider);
  }

  res.json({
    success: true,
    data: withLiveDisplayData(order),
    ...(riderAssignment ? { riderAssignment } : {}),
  });
});

const getAllOrders = asyncHandler(async (req, res) => {
  const { status, restaurant, page = 1, limit = 20 } = req.query;
  const filter = {};
  if (status)     filter.status     = status;
  if (restaurant) filter.restaurant = restaurant;

  const skip = (Number(page) - 1) * Number(limit);
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .populate('user', 'name phone')
      .populate(ORDER_POPULATE_PATHS)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    Order.countDocuments(filter),
  ]);

  res.json({
    success: true,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
    total,
    data: orders.map(withLiveDisplayData),
  });
});

const createGuestOrder = asyncHandler(async (req, res) => {
  return res.status(410).json({
    success: false,
    message: 'Guest ordering is disabled. Please verify your phone number before placing an order.',
  });
});

const RIDER_LOCKED_FOR_REASSIGN = ['reached_restaurant', 'picked_up', 'out_for_delivery'];

const assignRider = asyncHandler(async (req, res) => {
  const { riderId } = req.body;
  if (!riderId) {
    return res.status(400).json({ success: false, message: 'riderId is required' });
  }

  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

  if (['delivered', 'cancelled'].includes(order.status)) {
    return res.status(409).json({
      success: false,
      message: `Cannot assign a rider — order is already ${order.status}.`,
    });
  }

  if (order.rider && RIDER_LOCKED_FOR_REASSIGN.includes(order.riderStatus)) {
    return res.status(409).json({
      success: false,
      message: 'Cannot reassign — this order is already being delivered by a rider.',
    });
  }

  const rider = await User.findOne({ _id: riderId, role: 'rider' });
  if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });
  if (!rider.isActive) {
    return res.status(409).json({ success: false, message: 'This rider is disabled and cannot be assigned.' });
  }

  order.rider = rider._id;
  order.riderAssignedAt = new Date();
  order.riderStatus = 'assigned';
  // Tip belongs to the rider. Set the earning once at assignment so
  // reassignment cannot double-count the same tip.
  const baseRiderFee = Number(order.deliveryFee) || 0;
  const verifiedTip = Number(order.tipAmount) || 0;
  order.riderEarning = order.riderEarning || (baseRiderFee + verifiedTip);
  order.riderStatusHistory = order.riderStatusHistory || [];
  order.riderStatusHistory.push({
    status: 'assigned',
    note: `Assigned to ${rider.name} by admin`,
    at: new Date(),
  });

  await order.save();
  await order.populate(ORDER_POPULATE_PATHS);

  // If manually assigned by admin, schedule the 60-second acceptance timeout check
  scheduleRiderTimeout(order._id, order.rider);

  res.json({ success: true, message: 'Rider assigned successfully.', data: withLiveDisplayData(order) });
});

module.exports = {
  createOrder, 
  getOrders, 
  getOrderById,
  getOrderReview,
  submitReview,
  cancelOrder, 
  rateOrder, 
  updateOrderStatus, 
  getAllOrders,
  createGuestOrder,
  assignRider
};

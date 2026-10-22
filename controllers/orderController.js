// File 2: controllers/orderController.js
const mongoose    = require('mongoose');
const crypto       = require('crypto');
const Order      = require('../models/Order');
const Cart       = require('../models/Cart');
const Address    = require('../models/Address');
const Restaurant = require('../models/Restaurant');
const Menu       = require('../models/Menu');
const User       = require('../models/User');
const Coupon     = require('../models/Coupon');
const Review     = require('../models/Review');
const IdempotencyKey = require('../models/IdempotencyKey');
const asyncHandler = require('express-async-handler');
const { releaseOrderInventory } = require('../services/inventoryReservationService');
const { autoAssignRider, scheduleRiderTimeout } = require('../services/riderAssignmentService');
const {
  getMenuRefId,
  groupItemsByRestaurant,
  allocateTip,
  resolveRestaurantNote,
  normalizeRestaurantNotes,
} = require('../services/checkoutMath');
const { createRazorpayOrder, assertConfigured } = require('../services/paymentService');
const { operationalStatus } = require('../services/restaurantHours');
const { notifyOrderStatus } = require('../services/notificationService');
const { initiateOrderRefund } = require('../services/refundService');
const { calculateRestaurantCommission, DEFAULT_COMMISSION_RATE } = require('../services/commissionService');
const { ensureOrderLedger } = require('../services/settlementService');
const { deadlinesFrom, isWithinCustomerCancellationWindow } = require('../services/orderCancellationPolicy');
const { getPlatformSettings, billPolicyFrom } = require('../services/platformSettingsService');
const { computeCheckoutBill, evaluateCheckoutGate } = require('../services/checkoutMath');
const { getZoneDeliveryCapacity, resolveOrderZone } = require('../services/riderAssignmentService');

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
    select: 'name image address owner phone deliveryMode businessType',
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
    order.deliveryMode = order.deliveryModeSnapshot || liveRestaurant.deliveryMode || 'eatswada_rider';
    order.businessType = order.businessTypeSnapshot || liveRestaurant.businessType || 'restaurant';

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
// Server-authoritative delivery + order pricing.
// Maynaguri launch rule: delivery is permitted only within the platform
// maximum of 10 km; the shared pricing service charges ₹30 within that cap.
// The browser may display an estimate, but values are recalculated here from
// database data and customer coordinates.
// ─────────────────────────────────────────────────────────────────────
// Delivery geo + fee helpers now come from the SINGLE source of truth in
// services/deliveryPricing.js (see #5). Changing the radius cap or fee there
// changes it everywhere — checkout and cart-preview can no longer drift apart.
const {
  MAX_DELIVERY_RADIUS_KM,
  validCoordinates,
  isPlaceholderRestaurantLocation,
  haversineKm,
  calculateDeliveryFee,
  calculatePolicyDeliveryFee,
} = require('../services/deliveryPricing');

// Customer tip is optional, but must stay within a sane server-side limit.
const MAX_TIP_AMOUNT = 500;

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

function calculateItemServerPrice(menuItem, requestedCustomizations) {
  let basePrice = Number(menuItem.price) || 0;
  let extraTotal = 0;
  let portionPrice = null;
  const selectedByGroup = {};
  // Backward compatibility: older clients submitted customization selections
  // as a flat array of labels (for example, ["Extra cheese"]). Keep accepting
  // that format, while newer clients can send group-aware selections.
  const legacySelectedLabels = new Set();
  const entries = Array.isArray(requestedCustomizations)
    ? requestedCustomizations
    : (requestedCustomizations && typeof requestedCustomizations === 'object'
      ? Object.entries(requestedCustomizations).map(([title, value]) => ({ title, selected: Array.isArray(value) ? value : [value] }))
      : []);

  for (const entry of entries) {
    if (typeof entry === 'string' || typeof entry === 'number') {
      const label = String(entry).trim();
      if (label) legacySelectedLabels.add(label);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const title = String(entry.title || '');
    if (!title) continue;
    let labels = [];
    if (Array.isArray(entry.selected)) labels = entry.selected.map(String);
    else if (Array.isArray(entry.options)) labels = entry.options.map(o => String(o && o.label != null ? o.label : o));
    else if (entry.label != null) labels = [String(entry.label)];
    selectedByGroup[title] = [...(selectedByGroup[title] || []), ...labels];
  }

  // Prices always come from the saved menu document, never from client-supplied prices.
  for (const group of (Array.isArray(menuItem.customizations) ? menuItem.customizations : [])) {
    const title = String(group.title || '');
    const options = Array.isArray(group.options) ? group.options : [];
    // Merge flat legacy labels into each matching group, matching the old
    // server behavior. Prices still come exclusively from the saved menu.
    const legacyLabelsForGroup = options
      .filter(option => legacySelectedLabels.has(String(option.label)))
      .map(option => String(option.label));
    const labels = [...(selectedByGroup[title] || []), ...legacyLabelsForGroup];
    if (group.pricingMode === 'portion' && labels.length > 1) {
      const err = new Error(`Please choose only one portion for "${title}".`);
      err.statusCode = 400;
      throw err;
    }
    for (const label of labels) {
      const option = options.find(o => String(o.label) === String(label));
      if (!option) {
        const err = new Error(`Invalid option "${label}" for "${title}".`);
        err.statusCode = 400;
        throw err;
      }
      const optionPrice = Math.max(0, Number(option.extraPrice || 0));
      if (group.pricingMode === 'portion') portionPrice = optionPrice;
      else extraTotal += optionPrice;
    }
  }

  basePrice = portionPrice == null ? basePrice : portionPrice;
  return Math.round((basePrice + extraTotal) * 100) / 100;
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
async function buildRestaurantPricing({ restaurantId, items, customerCoords, billPolicy = null }) {
  if (!mongoose.Types.ObjectId.isValid(restaurantId)) {
    const error = new Error('Invalid restaurant'); error.statusCode = 400; throw error;
  }

  const restaurant = await Restaurant.findOne({
    _id: restaurantId,
    isActive: true,
    approvalStatus: 'approved',
  })
    .select('name image owner location availability isOpen openingHours deliveryRadiusKm minOrder freeDeliveryEnabled freeDeliveryAbove commissionRate commissionPlan deliveryMode businessType');
  if (!restaurant) { const e = new Error('Restaurant not found or unavailable'); e.statusCode = 404; throw e; }

  const operational = operationalStatus(restaurant);
  if (!operational.open) {
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
  const menuDocs = await Menu.find({
    _id: { $in: uniqueIds },
    restaurantId: restaurant._id,
    isActive: { $ne: false },
    $or: [{ approvalStatus: 'approved' }, { approvalStatus: { $exists: false } }],
  }).lean();
  const menuMap = new Map(menuDocs.map(m => [String(m._id), m]));

  const serverItems = [];
  let subtotal = 0;
  for (const requested of items) {
    const rawId = requested?.menuItem || requested?.menuId || requested?.id || requested?._id;
    const menuItem = menuMap.get(String(rawId));
    if (!menuItem) { const e = new Error('A cart item no longer belongs to this restaurant. Please refresh your cart.'); e.statusCode = 409; throw e; }
    if (menuItem.isActive === false || (menuItem.approvalStatus && menuItem.approvalStatus !== 'approved')) { const e = new Error(`${menuItem.name || 'This item'} is not currently approved for ordering.`); e.statusCode = 409; throw e; }
    if (menuItem.inStock === false) { const e = new Error(`${menuItem.name} is currently out of stock.`); e.statusCode = 409; throw e; }
    const quantity = Number(requested.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) { const e = new Error(`Invalid quantity for ${menuItem.name}.`); e.statusCode = 400; throw e; }
    if (menuItem.trackStock && Number(menuItem.stockQuantity) < quantity) { const e = new Error(`${menuItem.name} has only ${Math.max(0, Number(menuItem.stockQuantity)||0)} unit(s) remaining.`); e.statusCode = 409; throw e; }
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

  // Per-restaurant delivery fee. When the platform bill policy is available
  // it prices by distance (base fee + per-km); otherwise the legacy flat ₹30
  // launch fee is used, so an unconfigured deployment is unchanged.
  const policyFee = billPolicy
    ? calculatePolicyDeliveryFee(distanceKm, billPolicy)
    : calculateDeliveryFee(distanceKm);
  const freeDeliveryAbove = Number(restaurant.freeDeliveryAbove || 0);
  const restaurantFreeDelivery = freeDeliveryAbove > 0 && subtotal >= freeDeliveryAbove;
  const baseDeliveryFee = policyFee;

  const commission = calculateRestaurantCommission({
    subtotal,
    discount: 0,
    rate: Number.isFinite(Number(restaurant.commissionRate))
      ? restaurant.commissionRate
      : DEFAULT_COMMISSION_RATE,
  });

  return {
    restaurant,
    serverItems,
    subtotal,
    baseDeliveryFee,
    restaurantFreeDelivery,
    // Legacy field kept for existing callers/tests: the fee after the
    // restaurant-level free-delivery waiver. The platform-level free-delivery
    // rules are applied later by computeCheckoutBill.
    deliveryFee: restaurantFreeDelivery ? 0 : baseDeliveryFee,
    distanceKm: Number(distanceKm.toFixed(2)),
    commission,
  };
}

// Shapes the checkout response. A SINGLE-restaurant checkout keeps the EXACT
// legacy shape ({ data: order, deliveryOtp }) so existing clients that redirect
// to track-order.html?id=data._id keep working unchanged. A multi-restaurant
// checkout additionally returns { multiple:true, orders:[...], deliveryOtps }.
function buildCheckoutResponse(orders, replay) {
  const shaped = orders.map(o => {
    const otp = replay ? (o.deliveryOtp || '') : (o._capturedOtp || '');
    const base = withLiveDisplayData(o);
    return {
      order: {
        ...base,
        orderNumber: o.orderNumber,
        shipmentId: o.shipmentId,
        publicOrderId: o.orderNumber,
        publicShipmentId: o.shipmentId,
        deliveryDistanceKm: o.deliveryDistanceKm,
        // Pillar 2 — itemized bill. `grandTotal` mirrors `total` for
        // backward compatibility; the itemized lines drive the receipt UI.
        bill: o.bill || null,
        grandTotal: Number(o.grandTotal ?? o.total ?? 0),
      },
      deliveryOtp: otp,
    };
  });

  const primary = orders[0];
  const isOnline = primary && primary.paymentMethod !== 'cod';
  const razorpayOrderId = orders.find(o => o.razorpayOrderId)?.razorpayOrderId || '';
  const amountPaise = Math.round(orders.reduce((sum, o) => sum + Number(o.total || 0), 0) * 100);
  const payment = isOnline && razorpayOrderId && process.env.RAZORPAY_KEY_ID
    ? { provider: 'razorpay', keyId: process.env.RAZORPAY_KEY_ID, orderId: razorpayOrderId, amount: amountPaise, currency: 'INR' }
    : null;

  if (shaped.length === 1) {
    return { success: true, replay: !!replay, checkoutGroupId: primary?.checkoutGroupId || null, data: shaped[0].order, deliveryOtp: shaped[0].deliveryOtp, ...(payment ? { payment } : {}) };
  }

  return {
    success: true,
    replay: !!replay,
    multiple: true,
    count: shaped.length,
    checkoutGroupId: primary?.checkoutGroupId || null,
    data: shaped[0].order,
    orders: shaped.map(s => s.order),
    deliveryOtps: shaped.reduce((acc, s) => { acc[s.order._id] = s.deliveryOtp; return acc; }, {}),
    ...(payment ? { payment } : {}),
  };
}

async function resolveCheckoutCoupon(code, userId, subtotal, restaurantIds) {
  const normalized=String(code||'').trim().toUpperCase(); if(!normalized) return null;
  const now=new Date();
  const coupon=await Coupon.findOne({code:normalized,isActive:true,startsAt:{$lte:now},$or:[{expiresAt:null},{expiresAt:{$gt:now}}]});
  if(!coupon){const e=new Error('Coupon is invalid or expired.');e.statusCode=400;throw e;}
  if(coupon.usageLimit!=null && coupon.usedCount>=coupon.usageLimit){const e=new Error('Coupon usage limit has been reached.');e.statusCode=409;throw e;}
  const prior=await require('../models/CouponRedemption').countDocuments({coupon:coupon._id,user:userId});
  if(prior>=Number(coupon.perUserLimit||1)){const e=new Error('You have already used this coupon.');e.statusCode=409;throw e;}
  if(coupon.firstOrderOnly && await Order.exists({user:userId,status:'delivered'})){const e=new Error('This coupon is for first orders only.');e.statusCode=400;throw e;}
  if(Number(subtotal)<Number(coupon.minSubtotal||0)){const e=new Error(`Minimum subtotal for this coupon is ₹${coupon.minSubtotal}.`);e.statusCode=400;throw e;}
  if(coupon.restaurant && (restaurantIds.length!==1 || String(coupon.restaurant)!==String(restaurantIds[0]))){const e=new Error('Coupon is not valid for this checkout.');e.statusCode=400;throw e;}
  let discount=coupon.type==='percent'?Number(subtotal)*Number(coupon.value)/100:Number(coupon.value);
  if(coupon.maxDiscount!=null) discount=Math.min(discount,Number(coupon.maxDiscount));
  return {coupon,discount:Math.round(Math.max(0,Math.min(discount,subtotal))*100)/100};
}

const createOrder = asyncHandler(async (req, res) => {
  const {
    items,
    deliveryAddress,
    addressId,
    paymentMethod = 'upi',
    restaurantNote,
    restaurantNotes,
    globalNote,
    deliveryInstructions,
    tipAmount = 0,
    couponCode = '',
  } = req.body;

  // Pillar 3 — dual payment engine. Both methods are gated by the platform
  // configuration below; the client's value is only a request, never a grant.
  const requestedMethod = String(paymentMethod || 'upi').toLowerCase();
  if (!['upi', 'cod'].includes(requestedMethod)) {
    const e = new Error('Payment method must be either UPI or Cash on Delivery.'); e.statusCode = 400; throw e;
  }
  if (requestedMethod === 'upi') assertConfigured();
  if (!Array.isArray(items) || items.length === 0) {
    const e = new Error('Cart is empty'); e.statusCode = 400; throw e;
  }

  // ── Platform configuration (maintenance, shortage, bill, payment) ───
  const settings = await getPlatformSettings();
  const billPolicy = billPolicyFrom(settings);

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

  // ── Pillar 1: Platform maintenance circuit breaker ──────────────────
  // Checked before any pricing work. An idempotent REPLAY of an already-placed
  // checkout above is intentionally allowed to succeed — it creates nothing.
  if (settings.isUnderMaintenance === true) {
    return res.status(503).json({
      success: false,
      code: 'PLATFORM_MAINTENANCE',
      message: settings.maintenanceMessage || 'Eatswada is under maintenance. Ordering is paused right now.',
      maintenanceTitle: settings.maintenanceTitle || 'Eatswada is under maintenance',
      maintenanceEta: settings.maintenanceEta || '',
    });
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

  // ── Pillar 1: rider-shortage circuit breaker ────────────────────────
  // Manual pause OR automatic capacity breach blocks new checkouts. The
  // capacity snapshot is only fetched when the automatic breaker is armed, so
  // an idle deployment pays nothing for it.
  if (settings.isDeliveryPausedShortage === true ||
      (settings.autoShortageCircuitBreaker === true && groups.length)) {
    const zone = await resolveOrderZone({ restaurant: groups[0].restaurantId });
    const capacity = await getZoneDeliveryCapacity(zone);
    const gate = evaluateCheckoutGate({
      settings,
      onlineRiders: capacity.onlineRiders,
      activeOrders: capacity.activeOrders,
    });
    if (gate) {
      return res.status(gate.statusCode).json({ success: false, ...gate, deliveryCapacity: capacity });
    }
  }

  // ── Price EVERY restaurant before creating anything ─────────────────
  const priced = [];
  for (const group of groups) {
    priced.push(await buildRestaurantPricing({
      restaurantId: group.restaurantId,
      items: group.items,
      customerCoords,
      billPolicy,
    }));
  }

  // Apply one server-authoritative coupon to the checkout. Restaurant-specific
  // coupons are restricted to a single matching restaurant; platform coupons
  // may span a multi-restaurant checkout. The discount is allocated by food
  // subtotal so it is never duplicated across child orders.
  const checkoutSubtotal = priced.reduce((sum,p)=>sum+Number(p.subtotal||0),0);
  const couponInfo = await resolveCheckoutCoupon(couponCode, req.user._id, checkoutSubtotal, priced.map(p=>p.restaurant._id));
  if (couponInfo) {
    for (const p of priced) {
      const share = checkoutSubtotal > 0 ? Number(p.subtotal) / checkoutSubtotal : 0;
      p.discount = Math.round(couponInfo.discount * share * 100) / 100;
      p.commission = calculateRestaurantCommission({ subtotal:p.subtotal, discount:p.discount, rate:Number.isFinite(Number(p.restaurant.commissionRate))?p.restaurant.commissionRate:DEFAULT_COMMISSION_RATE });
    }
    const allocated=priced.reduce((a,p)=>a+Number(p.discount||0),0);
    if (priced.length && Math.abs(allocated-couponInfo.discount)>0.01) priced[priced.length-1].discount=Math.round((Number(priced.at(-1).discount||0)+(couponInfo.discount-allocated))*100)/100;
  }

  // ── Pillar 3: dual payment engine gating ────────────────────────────
  // COD is only available when the platform enables it, the customer is not
  // COD-blocked, and the checkout total is within the COD cap. All three are
  // validated server-side against the customer document, never the client.
  const customer = await User.findById(req.user._id).select('name phone isCodBlocked').lean();
  if (requestedMethod === 'cod') {
    if (settings.isCodEnabled !== true) {
      const e = new Error('Cash on Delivery is currently unavailable. Please pay online.'); e.statusCode = 400; throw e;
    }
    if (customer?.isCodBlocked === true) {
      const e = new Error('Cash on Delivery is not available for your account. Please pay online.'); e.statusCode = 403; throw e;
    }
    if (priced.length > 1) {
      const e = new Error('Cash on Delivery is available for single-restaurant orders only. Please pay online for a multi-restaurant order.'); e.statusCode = 403; throw e;
    }
  } else if (settings.isUpiEnabled !== true) {
    const e = new Error('Online (UPI) payment is temporarily unavailable. Please try again shortly.'); e.statusCode = 503; throw e;
  }

  // Split the tip across restaurants by delivery fee (never duplicated).
  const tipShares = allocateTip(totalTip, priced.map(p => p.deliveryFee));

  const isSingle = priced.length === 1;
  const isFirstOrder = !(await Order.exists({ user: req.user._id }));
  const perRestaurantNotes = normalizeRestaurantNotes(restaurantNotes, mongoose.Types.ObjectId.isValid);
  const sharedDeliveryInstructions = typeof deliveryInstructions === 'string'
    ? deliveryInstructions.trim().slice(0, 250) : '';

  // ── Pillar 2: itemized bill per restaurant ──────────────────────────
  // computeCheckoutBill applies the platform free-delivery / handling /
  // small-cart / rain-surge rules on top of the distance fee.
  const bills = priced.map((p, i) => computeCheckoutBill({
    subtotal: p.subtotal,
    deliveryFee: p.deliveryFee,
    discountAmount: Number(p.discount || 0),
    tipAmount: tipShares[i] || 0,
    itemCount: (p.serverItems || []).reduce((n, it) => n + Number(it.quantity || 0), 0),
    policy: billPolicy,
    isFirstOrder,
    restaurantFreeDeliveryApplied: p.restaurantFreeDelivery === true,
  }));

  const checkoutGrandTotal = bills.reduce((sum, b) => sum + b.grandTotal, 0);

  if (requestedMethod === 'cod') {
    const maxCod = Number(settings.maxCodOrderAmount);
    if (Number.isFinite(maxCod) && maxCod > 0 && checkoutGrandTotal > maxCod) {
      const e = new Error(`Cash on Delivery is available for orders up to ₹${maxCod}. Please pay online for this order.`);
      e.statusCode = 400; throw e;
    }
  }

  // ── Atomic idempotency lock ─────────────────────────────────────────
  // Address resolution, pricing and the closed / out-of-stock checks above can
  // all legitimately reject a checkout, so we only CLAIM the key here — right
  // before creating orders — and a rejected checkout never traps the key.
  //
  // The unique _id on the IdempotencyKey collection is the atomic guarantee: if
  // a second, truly-simultaneous POST with the same key reaches this line, its
  // insert throws a duplicate-key error (E11000) and it does NOT create a second
  // order set. The order-replay read near the top of createOrder still handles
  // ordinary sequential retries; this only closes the concurrent double-tap
  // window the old check-then-write left open.
  const idempotencyLockId = idempotencyKey ? `${req.user._id}:${idempotencyKey}` : null;
  if (idempotencyLockId) {
    try {
      await IdempotencyKey.create({ _id: idempotencyLockId, user: req.user._id, key: idempotencyKey });
    } catch (err) {
      if (err && err.code === 11000) {
        // Another request already claimed this key. If it has finished creating
        // the orders, replay them; otherwise tell the client to wait rather than
        // duplicating the checkout.
        const inFlight = await Order.find({ user: req.user._id, idempotencyKey })
          .select('+deliveryOtp')
          .populate(ORDER_POPULATE_PATHS)
          .sort({ createdAt: 1 });
        if (inFlight.length) {
          return res.status(200).json(buildCheckoutResponse(inFlight, true));
        }
        const e = new Error('This order is already being placed. Please wait a moment, then check My Orders.');
        e.statusCode = 409;
        throw e;
      }
      throw err;
    }
  }

  // ── Create one order per restaurant ─────────────────────────────────
  // Everything from here through the payment step is wrapped so that ANY failure
  // (a mid-loop create error, or Razorpay init failing) rolls back the pending
  // orders AND releases the idempotency lock — otherwise a held lock would wedge
  // the customer behind the 409 above and they could never retry.
  const created = [];
  // One checkout can create multiple restaurant-specific Order documents.
  // Generate exactly one server-side group id and persist it on every child.
  // This identifier is never trusted from the browser.
  const checkoutGroupId = crypto.randomUUID();
  try {
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
      const bill = bills[i];

      const order = await Order.create({
        user: req.user._id,
        restaurant: p.restaurant._id,
        restaurantName: p.restaurant.name,
        restaurantImage: p.restaurant.image || '',
        deliveryModeSnapshot: p.restaurant.deliveryMode || 'eatswada_rider',
        businessTypeSnapshot: p.restaurant.businessType || 'restaurant',
        checkoutGroupId,
        customerName: customer?.name || '',
        customerPhone: customer?.phone || '',
        items: p.serverItems,
        deliveryAddress: { ...addressSnapshot, coordinates: customerCoords },
        deliveryDistanceKm: p.distanceKm,
        subtotal: p.subtotal,
        // deliveryFee stores the FINAL (post free-delivery waiver) fee so every
        // legacy consumer of order.deliveryFee sees exactly what was charged.
        deliveryFee: bill.deliveryFee,
        discount: Number(p.discount || 0),
        coupon: couponInfo ? { code: couponInfo.coupon.code, discount: Number(p.discount || 0), couponId: couponInfo.coupon._id } : undefined,
        // Itemized bill snapshot (Pillar 2) — the customer's receipt.
        bill: { ...bill, tipAmount: tip },
        commission: {
          rate: p.commission.rate,
          baseAmount: p.commission.baseAmount,
          amount: p.commission.amount,
          restaurantNetAmount: p.commission.restaurantNetAmount,
          calculatedAt: new Date(),
        },
        restaurantNote: note,
        deliveryInstructions: sharedDeliveryInstructions,
        tipAmount: tip,
        total: bill.grandTotal,
        grandTotal: bill.grandTotal,
        customerCancellationDeadline: deadlinesFrom(new Date()).customerCancellationDeadline,
        restaurantResponseDeadline: null,
        paymentMethod: requestedMethod,
        // COD orders are paid at the door: they start as cod_pending and the
        // rider flips them to cod_collected on handoff (see riderController).
        paymentStatus: requestedMethod === 'cod' ? 'cod_pending' : 'pending',
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });

      order._capturedOtp = order._plainDeliveryOtp;
      order.clearOtpSecrets();
      await order.populate(ORDER_POPULATE_PATHS);
      created.push(order);
    }

    if (requestedMethod === 'upi') {
      const checkoutTotal = created.reduce((sum, order) => sum + Number(order.total || 0), 0);
      const razorpayOrder = await createRazorpayOrder(
        checkoutTotal,
        created[0].orderNumber || created[0]._id,
        {
          userId: String(req.user._id),
          orderIds: created.map(o => String(o._id)).join(',').slice(0, 240),
        }
      );
      await Order.updateMany(
        { _id: { $in: created.map(o => o._id) }, user: req.user._id },
        { $set: { razorpayOrderId: razorpayOrder.id } }
      );
      created.forEach(order => { order.razorpayOrderId = razorpayOrder.id; });
    }
    // COD orders need no gateway step: they are already created as
    // `cod_pending` and go straight to the vendor queue.
  } catch (err) {
    // Roll back everything this checkout created and release the lock so the
    // customer can safely retry. Mirrors (and unifies) the original
    // Razorpay-failure cleanup.
    if (created.length) {
      await Order.deleteMany({ _id: { $in: created.map(o => o._id) }, user: req.user._id, paymentStatus: { $in: ['pending', 'cod_pending'] } }).catch(() => {});
    }
    if (idempotencyLockId) {
      await IdempotencyKey.deleteOne({ _id: idempotencyLockId }).catch(() => {});
    }
    throw err;
  }

  return res.status(201).json(buildCheckoutResponse(created, false));
});

// Average delivery speed (km/h) for a rough live ETA. Conservative for local
// roads — an estimate, not a promise.
const AVG_DELIVERY_SPEED_KMH = 18;
const LIVE_RIDER_STATUSES = ['picked_up', 'out_for_delivery'];

// Attach the rider's live position + ETA to a customer-facing order object —
// ONLY while the order is actually on the move and the rider app has sent a
// GPS fix. At any other stage nothing is exposed. Requires the order's `rider`
// to have been populated with `riderDetails.currentLocation`.
function enrichRiderLive(data, orderDoc) {
  const rider = orderDoc.rider && typeof orderDoc.rider === 'object' ? orderDoc.rider : null;
  const riderCoords = rider?.riderDetails?.currentLocation?.coordinates;
  const destCoords = orderDoc.deliveryAddress?.coordinates;
  if (
    LIVE_RIDER_STATUSES.includes(orderDoc.riderStatus) &&
    validCoordinates(riderCoords) &&
    validCoordinates(destCoords)
  ) {
    const distanceKm = haversineKm(riderCoords, destCoords);
    data.riderLocation = {
      lat: Number(riderCoords[1]),
      lng: Number(riderCoords[0]),
      updatedAt: rider.riderDetails.currentLocation.updatedAt || null,
    };
    data.riderDistanceKm = Number(distanceKm.toFixed(2));
    data.riderEtaMinutes = Math.max(1, Math.round((distanceKm / AVG_DELIVERY_SPEED_KMH) * 60));
  }
  return data;
}

// Launch-fix: never trust a client-provided page/limit (limit=0 used to
// return every order; a non-numeric page produced a NaN skip).
const clampPageParam = (v) => Math.max(1, Math.floor(Number(v)) || 1);
const clampLimitParam = (v, fallback, max) => Math.min(max, Math.max(1, Math.floor(Number(v)) || fallback));

const getOrders = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const page = clampPageParam(req.query.page);
  const limit = clampLimitParam(req.query.limit, 10, 50);
  const filter = { user: req.user._id };
  if (typeof status === 'string' && status) filter.status = status;

  const skip = (page - 1) * limit;
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .select('+deliveryOtp')
      .populate(ORDER_POPULATE_PATHS)
      .populate('rider', 'name phone riderDetails.currentLocation')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Order.countDocuments(filter),
  ]);

  res.json({
    success: true,
    page,
    pages: Math.ceil(total / limit),
    total,
    data: orders.map(o => enrichRiderLive(withLiveDisplayData(o), o)),
  });
});

const getOrderById = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, user: req.user._id })
    .select('+deliveryOtp')
    .populate(ORDER_POPULATE_PATHS)
    .populate('rider', 'name phone riderDetails.currentLocation');
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  res.json({ success: true, data: enrichRiderLive(withLiveDisplayData(order), order) });
});

const cancelOrder = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

  // Customer cancellation is deliberately limited to the first 30 seconds
  // after order creation. This is server-authoritative; the frontend timer is
  // only a convenience and cannot extend the window.
  if (order.status === 'cancelled') {
    return res.status(409).json({ success: false, message: 'This order is already cancelled.' });
  }
  if (!order.isCancellable || !isWithinCustomerCancellationWindow(order)) {
    return res.status(409).json({
      success: false,
      message: 'The 30-second cancellation window has expired or this order is already being prepared.',
    });
  }

  const reason = (typeof req.body.reason === 'string' && req.body.reason.trim()) || 'Cancelled by customer';
  order.advanceStatus('cancelled', reason);
  order.cancelReason = reason;
  order.cancellationResponsibility = 'customer';

  // Launch-fix: persist the cancellation FIRST. If the restaurant accepted the
  // order a moment earlier, this save fails with VersionError (409) and no
  // refund is sent for an order that is actually going ahead.
  await order.save();
  await releaseOrderInventory(order, req.user._id);

  // Then refund online payments that were actually captured. The refund
  // service claims the refund atomically, so it can never run twice, and it
  // persists its own result (do not save the order again after this).
  await initiateOrderRefund(order, reason);
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
  const requestedItemRatings = Array.isArray(req.body?.itemRatings) ? req.body.itemRatings : [];
  if (requestedItemRatings.length > 100) return res.status(400).json({ success:false, message:'Too many item ratings.' });
  const requestedPhotos = Array.isArray(req.body?.photos) ? req.body.photos : [];
  if (requestedPhotos.length > 4) return res.status(400).json({ success: false, message: 'A review can include up to 4 photos.' });
  const photos = requestedPhotos.map(value => String(value || '').trim()).filter(Boolean);
  if (photos.some(url => url.length > 1000 || !/^https:\/\/res\.cloudinary\.com\//i.test(url))) {
    return res.status(400).json({ success: false, message: 'Review photos must be uploaded through the customer image upload endpoint.' });
  }
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
  const itemRatings = [];
  const seenItemKeys = new Set();
  for (const raw of requestedItemRatings) {
    const itemName = String(raw?.itemName || raw?.name || '').trim().slice(0,160);
    const scoreValue = Number(raw?.score);
    if (!itemName || !Number.isInteger(scoreValue) || scoreValue < 1 || scoreValue > 5) return res.status(400).json({ success:false, message:'Each item rating requires an item name and a whole-number score from 1 to 5.' });
    const orderItem = (order.items || []).find(line => String(line.name || '').trim().toLowerCase() === itemName.toLowerCase() || (raw?.menuItem && line.menuItem && String(line.menuItem) === String(raw.menuItem)));
    if (!orderItem) return res.status(400).json({ success:false, message:`Item rating does not match an item in this order: ${itemName}.` });
    const key = String(orderItem.menuItem || orderItem.name).toLowerCase();
    if (seenItemKeys.has(key)) return res.status(400).json({ success:false, message:`Duplicate rating for ${itemName}.` });
    seenItemKeys.add(key);
    itemRatings.push({ menuItem: orderItem.menuItem || null, itemName: orderItem.name, score: scoreValue, comment: String(raw?.comment || '').trim().slice(0,300) });
  }
  let review = await Review.findOne({ order: order._id });
  const wasNewReview = !review;
  if (review && String(review.user) !== String(req.user._id)) return res.status(403).json({ success: false, message: 'Not authorized.' });

  if (review) {
    review.score = numericScore;
    review.riderScore = numericRiderScore;
    review.comment = cleanComment;
    review.photos = photos;
    review.itemRatings = itemRatings;
    review.isVisible = true;
    review.adminNote = '';
  } else {
    review = new Review({ restaurant: order.restaurant, user: req.user._id, order: order._id, score: numericScore, riderScore: numericRiderScore, comment: cleanComment, photos, itemRatings });
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

  if (order.paymentMethod !== 'cod' && order.paymentStatus !== 'paid') {
    return res.status(402).json({ success: false, message: 'Online payment has not been captured yet.' });
  }

  if (status === 'delivered' && !order.deliveryOtpVerified) {
    return res.status(409).json({
      success: false,
      message: 'Cannot mark this order as delivered until the delivery OTP has been verified.',
    });
  }

  order.advanceStatus(status, note || '');

  let riderAssignment = null;
  if (status === 'waiting_for_rider') {
    // A ready event overrides the planned dispatch time; food is ready now.
    order.dispatchNotBefore = new Date();
    if (order.rider && ['accepted', 'reached_restaurant'].includes(order.riderStatus)) {
      order.advanceStatus('assigned', 'Rider already accepted; restaurant marked food ready');
      order.dispatchStatus = 'assigned';
    } else if (!order.rider && order.deliveryModeSnapshot !== 'self_delivery') {
      riderAssignment = await autoAssignRider(order);
    }
  }

  await order.save();
  if (status === 'delivered') await ensureOrderLedger(order);
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
  const { status, restaurant } = req.query;
  const page = clampPageParam(req.query.page);
  const limit = clampLimitParam(req.query.limit, 20, 100);
  const filter = {};
  if (typeof status === 'string' && status) filter.status = status;
  if (restaurant) {
    if (!mongoose.Types.ObjectId.isValid(String(restaurant))) {
      return res.status(400).json({ success: false, message: 'Invalid restaurant id.' });
    }
    filter.restaurant = restaurant;
  }

  const skip = (page - 1) * limit;
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .populate('user', 'name phone')
      .populate(ORDER_POPULATE_PATHS)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Order.countDocuments(filter),
  ]);

  res.json({
    success: true,
    page,
    pages: Math.ceil(total / limit),
    total,
    data: orders.map(o => enrichRiderLive(withLiveDisplayData(o), o)),
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
  order.dispatchStatus = 'assigned';
  order.dispatchStartedAt = order.dispatchStartedAt || new Date();
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

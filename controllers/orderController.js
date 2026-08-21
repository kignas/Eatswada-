// File 2: controllers/orderController.js
const mongoose    = require('mongoose');
const Order      = require('../models/Order');
const Cart       = require('../models/Cart');
const Address    = require('../models/Address');
const Restaurant = require('../models/Restaurant');
const Menu       = require('../models/Menu');
const User       = require('../models/User');
const asyncHandler = require('express-async-handler');
const { autoAssignRider, scheduleRiderTimeout } = require('../services/riderAssignmentService');

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

async function buildAuthoritativeOrderPricing({ items, restaurantId, deliveryAddress, addressId, userId }) {
  if (!Array.isArray(items) || items.length === 0) {
    const error = new Error('Cart is empty');
    error.statusCode = 400;
    throw error;
  }

  if (!mongoose.Types.ObjectId.isValid(restaurantId)) {
    const error = new Error('Invalid restaurant');
    error.statusCode = 400;
    throw error;
  }

  const restaurant = await Restaurant.findOne({
    _id: restaurantId,
    isActive: true,
  }).select('name image owner location availability isOpen deliveryRadiusKm freeDeliveryEnabled freeDeliveryAbove');

  if (!restaurant) {
    const error = new Error('Restaurant not found or unavailable');
    error.statusCode = 404;
    throw error;
  }

  const restaurantCoords = restaurant.location?.coordinates;
  if (!validCoordinates(restaurantCoords) || isPlaceholderRestaurantLocation(restaurantCoords)) {
    const error = new Error(
      'This restaurant does not have a verified map location yet. Please try another restaurant.'
    );
    error.statusCode = 409;
    throw error;
  }

  const { coords: customerCoords, snapshot: addressSnapshot } = await resolveDeliveryAddress({
    addressId,
    deliveryAddress,
    userId,
  });

  if (!customerCoords) {
    const error = new Error(
      'Please select your delivery location using GPS/Google Maps before placing the order.'
    );
    error.statusCode = 400;
    throw error;
  }

  const distanceKm = haversineKm(restaurantCoords, customerCoords);

  // Keep the platform-wide launch cap, while allowing Admin to configure a
  // smaller delivery radius per restaurant.
  const configuredRadius = Number(restaurant.deliveryRadiusKm);
  const effectiveRadius = Number.isFinite(configuredRadius) && configuredRadius > 0
    ? Math.min(configuredRadius, MAX_DELIVERY_RADIUS_KM)
    : MAX_DELIVERY_RADIUS_KM;

  if (distanceKm > effectiveRadius) {
    const error = new Error(
      `This address is ${distanceKm.toFixed(1)} km away. This restaurant delivers only within ${effectiveRadius.toFixed(1).replace(/\.0$/, '')} km.`
    );
    error.statusCode = 400;
    throw error;
  }

  const menuIds = items.map(item => item?.menuItem || item?.menuId || item?.id || item?._id);
  if (menuIds.some(id => !mongoose.Types.ObjectId.isValid(id))) {
    const error = new Error('One or more cart items are invalid or outdated. Please refresh your cart.');
    error.statusCode = 400;
    throw error;
  }

  const uniqueIds = [...new Set(menuIds.map(String))];
  const menuDocs = await Menu.find({
    _id: { $in: uniqueIds },
    restaurantId: restaurant._id,
  }).lean();

  const menuMap = new Map(menuDocs.map(item => [String(item._id), item]));
  const serverItems = [];
  let subtotal = 0;

  for (const requested of items) {
    const rawId = requested?.menuItem || requested?.menuId || requested?.id || requested?._id;
    const menuItem = menuMap.get(String(rawId));

    if (!menuItem) {
      const error = new Error('A cart item no longer belongs to this restaurant. Please refresh your cart.');
      error.statusCode = 409;
      throw error;
    }

    if (menuItem.inStock === false) {
      const error = new Error(`${menuItem.name} is currently out of stock.`);
      error.statusCode = 409;
      throw error;
    }

    const quantity = Number(requested.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      const error = new Error(`Invalid quantity for ${menuItem.name}.`);
      error.statusCode = 400;
      throw error;
    }

    const unitPrice = calculateItemServerPrice(menuItem, requested.customizations);
    const lineTotal = unitPrice * quantity;
    subtotal += lineTotal;

    serverItems.push({
      menuItem: menuItem._id,
      name: menuItem.name,
      price: unitPrice,
      originalPrice: Number(menuItem.originalPrice) > Number(unitPrice) ? Number(menuItem.originalPrice) : null,
      image: menuItem.image || '',
      isVeg: !!menuItem.isVeg,
      quantity,
      customizations: requested.customizations || {},
    });
  }

  const baseDeliveryFee = calculateDeliveryFee(distanceKm);
  const freeDeliveryEnabled = restaurant.freeDeliveryEnabled !== false;
  const freeDeliveryAbove = Number(restaurant.freeDeliveryAbove || 0);
  const deliveryFee = freeDeliveryEnabled && freeDeliveryAbove > 0 && subtotal >= freeDeliveryAbove
    ? 0
    : baseDeliveryFee;
  const total = subtotal + deliveryFee;

  return {
    restaurant,
    serverItems,
    subtotal,
    deliveryFee,
    total,
    distanceKm: Number(distanceKm.toFixed(2)),
    customerCoords,
    addressSnapshot,
  };
}

const createOrder = asyncHandler(async (req, res) => {
  const {
    items,
    restaurantId,
    deliveryAddress,
    addressId,
    paymentMethod = 'upi',
  } = req.body;

  const pricing = await buildAuthoritativeOrderPricing({
    items,
    restaurantId,
    deliveryAddress,
    addressId,
    userId: req.user._id,
  });

  // Never trust client-provided restaurantName, item prices, subtotal,
  // deliveryFee, or total. Address text/coordinates now also
  // come from pricing.addressSnapshot/customerCoords, resolved server-side
  // from the saved Address document when addressId is supplied.
  const customer = await User.findById(req.user._id).select('name phone').lean();

  const addressSnapshot = {
    ...pricing.addressSnapshot,
    coordinates: pricing.customerCoords,
  };

  const order = await Order.create({
    user: req.user._id,
    restaurant: pricing.restaurant._id,
    restaurantName: pricing.restaurant.name,
    restaurantImage: pricing.restaurant.image || '',
    customerName: customer?.name || '',
    customerPhone: customer?.phone || '',
    items: pricing.serverItems,
    deliveryAddress: addressSnapshot,
    deliveryDistanceKm: pricing.distanceKm,
    subtotal: pricing.subtotal,
    deliveryFee: pricing.deliveryFee,
    total: pricing.total,
    paymentMethod,
    paymentStatus: paymentMethod === 'cod' ? 'pending' : 'pending',
  });

  const deliveryOtp = order._plainDeliveryOtp;
  order.clearOtpSecrets();
  await order.populate(ORDER_POPULATE_PATHS);

  res.status(201).json({
    success: true,
    data: {
      ...withLiveDisplayData(order),
      orderNumber: order.orderNumber,
      shipmentId: order.shipmentId,
      publicOrderId: order.orderNumber,
      publicShipmentId: order.shipmentId,
      deliveryDistanceKm: pricing.distanceKm,
    },
    deliveryOtp,
  });
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
  if (!order.isCancellable)
    return res.status(400).json({ success: false, message: 'Order cannot be cancelled at this stage' });

  order.advanceStatus('cancelled', req.body.reason || 'Cancelled by customer');
  order.cancelReason = req.body.reason || 'Cancelled by customer';
  await order.save();
  await order.populate(ORDER_POPULATE_PATHS);

  res.json({ success: true, message: 'Order cancelled', data: withLiveDisplayData(order) });
});

const rateOrder = asyncHandler(async (req, res) => {
  const { score, comment } = req.body;
  const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  if (order.status !== 'delivered')
    return res.status(400).json({ success: false, message: 'You can only rate delivered orders' });

  order.rating = { score, comment, givenAt: new Date() };
  await order.save();
  await order.populate(ORDER_POPULATE_PATHS);
  res.json({ success: true, data: withLiveDisplayData(order) });
});

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
  order.riderEarning = order.riderEarning || order.deliveryFee || 0;
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
  cancelOrder, 
  rateOrder, 
  updateOrderStatus, 
  getAllOrders,
  createGuestOrder,
  assignRider
};

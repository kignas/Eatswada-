const mongoose = require('mongoose');
const Restaurant = require('../models/Restaurant');
const MenuItem   = require('../models/Menu');
const asyncHandler = require('express-async-handler');
const Review = require('../models/Review');
const Order = require('../models/Order');
const Cart = require('../models/Cart');
const User = require('../models/User');
const RestaurantDeletionAudit = require('../models/RestaurantDeletionAudit');
const {
  operationalStatus,
  getLocalContext,
  buildOpeningHoursUpdate,
  validTime,
  withOperationalAvailability,
} = require('../services/restaurantHours');
const { buildAvailabilityExpr } = require('../services/restaurantAvailability');
const { withServiceability, getRankingConfig } = require('../services/restaurantRankingService');
const { resolveRoute } = require('../services/pricing/routeService');

const clampPage = (value, fallback = 1) => Math.max(1, Number(value) || fallback);
const clampLimit = (value, fallback = 20, max = 100) => Math.min(max, Math.max(1, Number(value) || fallback));
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');


// Only return fields required by customer restaurant-list consumers. This keeps
// the existing response shape intact while avoiding private/admin/vendor data.
const CUSTOMER_LIST_PROJECTION = {
  _id: 1,
  name: 1,
  slug: 1,
  image: 1,
  images: 1,
  cuisine: 1,
  cuisineDisplay: 1,
  rating: 1,
  ratingCount: 1,
  estimatedDeliveryMin: 1,
  estimatedDeliveryMax: 1,
  // NOTE: the stored `distanceMeters` / `distance` fields are static seed values
  // (e.g. "2.0 km") that do not depend on the customer's location, so they are
  // intentionally NOT returned. Customer-facing distance is `distanceKm`,
  // computed per request from the customer's coordinates.
  time: 1,
  offer: 1,
  minOrder: 1,
  deliveryFee: 1,
  freeDeliveryAbove: 1,
  freeDeliveryEnabled: 1,
  deliveryRadiusKm: 1,
  isVeg: 1,
  isOpen: 1,
  availability: 1,
  openingHours: 1,
  isActive: 1,
  isFeatured: 1,
  isBestSeller: 1,
  isNearFast: 1,
  homeOrder: 1,
  displayPriority: 1,
  // Ranking engine fields.
  isPinned: 1,
  pinnedUntil: 1,
  isSponsored: 1,
  sponsoredUntil: 1,
  sponsorLabel: 1,
  performance: 1,
  reviewCount: 1,
  totalOrders: 1,
  address: 1,
  location: 1,
  categories: 1,
  businessType: 1,
  deliveryMode: 1,
  createdAt: 1,
  updatedAt: 1
};

/**
 * Restaurant-level authorization for Availability + Permissions feature:
 *  - CEO (admin) can manage every restaurant.
 *  - Vendor can only manage a restaurant they own.
 * Used by updateRestaurant, deleteRestaurant, and updateRestaurantAvailability.
 */
const canManageRestaurant = (user, restaurant) => {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return user.role === 'vendor' && restaurant.owner.toString() === user._id.toString();
};

// ── Lean menu documents with hydration-equivalent defaults ────────────────
// .lean() skips Mongoose document hydration, which is the main CPU cost of the
// menu endpoint. Hydration is ALSO what fills schema defaults into documents
// that were saved before a field existed (e.g. items created before `inStock`,
// `sortOrder` or `minSelect`/`maxSelect` were added). To keep the JSON
// byte-for-byte compatible, the same defaults are re-applied to missing
// (undefined) fields only. Values are read from models/Menu.js at startup so
// they follow the schema; the literals are only a fallback.
function schemaDefaults(schema, fallbacks) {
  const out = {};
  for (const [path, fallback] of Object.entries(fallbacks)) {
    let value = fallback;
    try {
      const type = schema.path(path);
      value = type ? type.defaultValue : undefined;
    } catch (_) {
      value = fallback;
    }
    if (typeof value === 'function') value = fallback;
    if (value !== undefined) out[path] = value;
  }
  return out;
}

function childSchema(schema, path) {
  try {
    const type = schema && schema.path(path);
    return (type && type.schema) || null;
  } catch (_) {
    return null;
  }
}

const MENU_CUSTOMIZATION_SCHEMA = childSchema(MenuItem.schema, 'customizations');
const MENU_ITEM_DEFAULTS = schemaDefaults(MenuItem.schema, {
  description: '',
  image: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c',
  isVeg: true,
  category: 'Main Course',
  isUnder99: false,
  isBestseller: false,
  isRecommended: false,
  inStock: true,
  sortOrder: 0,
});
const MENU_GROUP_DEFAULTS = schemaDefaults(MENU_CUSTOMIZATION_SCHEMA, { required: false, minSelect: 0, maxSelect: 1, pricingMode: 'extra' });
const MENU_OPTION_DEFAULTS = schemaDefaults(childSchema(MENU_CUSTOMIZATION_SCHEMA, 'options'), { extraPrice: 0, isVeg: true });

function fillMissing(target, defaults) {
  for (const key of Object.keys(defaults)) {
    if (target[key] === undefined) target[key] = defaults[key];
  }
}

function applyMenuItemDefaults(item) {
  fillMissing(item, MENU_ITEM_DEFAULTS);
  if (item.customizations === undefined) item.customizations = [];
  if (Array.isArray(item.customizations)) {
    for (const group of item.customizations) {
      if (!group || typeof group !== 'object') continue;
      fillMissing(group, MENU_GROUP_DEFAULTS);
      if (group.options === undefined) group.options = [];
      if (Array.isArray(group.options)) {
        for (const option of group.options) {
          if (option && typeof option === 'object') fillMissing(option, MENU_OPTION_DEFAULTS);
        }
      }
    }
  }
  return item;
}

const getRestaurants = asyncHandler(async (req, res) => {
  const { veg, category, search, sort = 'recommended' } = req.query;
  const page = clampPage(req.query.page);
  const limit = clampLimit(req.query.limit, 20, 100);

  // Closed restaurants remain customer-visible, but marketplace ordering must
  // always put restaurants that can currently accept orders before closed ones.
  // This is done BEFORE pagination, otherwise page 1 could contain only closed
  // restaurants even when open restaurants exist on later pages.
  const filter = { isActive: true, approvalStatus: 'approved' };

  if (veg === 'true') filter.isVeg = true;
  if (category) filter.categories = { $in: [category] };
  if (search) filter.$text = { $search: search };

  const skip = (page - 1) * limit;
  const now = new Date();
  const hoursContext = getLocalContext(now);
  const rankingConfig = await getRankingConfig();

  // Optional customer coordinates → delivery distance + serviceability.
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const customerCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    ? [lng, lat]
    : null;

  // Effective availability is evaluated INSIDE the aggregation (same rules as
  // services/restaurantAvailability) so online-first ordering happens before
  // pagination without loading the whole collection into Node. This fixes the
  // long-standing bug where an autoHours restaurant closed by its weekly
  // schedule still sorted as "open" because the persisted flag was stale.
  const addFields = {
    __isOpen: buildAvailabilityExpr(hoursContext),
    // Legacy explicit homepage position (999999 = automatic). Kept as the
    // highest-priority key after availability so existing admin-set positions
    // keep working; new documents all tie on the default and fall through to
    // the performance ranking.
    __homeOrder: { $ifNull: ['$homeOrder', 999999] },
    __pinned: {
      $and: [
        { $eq: ['$isPinned', true] },
        { $or: [{ $eq: ['$pinnedUntil', null] }, { $gt: ['$pinnedUntil', now] }] },
      ],
    },
    __sponsored: {
      $and: [
        { $eq: ['$isSponsored', true] },
        { $or: [{ $eq: ['$sponsoredUntil', null] }, { $gt: ['$sponsoredUntil', now] }] },
      ],
    },
  };

  // Rank score = performance score, plus a clearly-labelled sponsored boost.
  // Sponsored placements get a bounded, disclosed advantage (never a silent
  // reorder), and it is capped so a sponsored restaurant cannot leapfrog a
  // much better one by an unbounded amount.
  const sponsoredBoost = rankingConfig.sponsoredEnabled ? Number(rankingConfig.sponsoredScoreBoost) || 0 : 0;
  addFields.__rankScore = {
    $add: [
      { $ifNull: ['$performance.score', 0] },
      { $cond: ['$__sponsored', sponsoredBoost, 0] },
    ],
  };

  // Distance sort must use the customer's real location, not the static stored
  // `distanceMeters`. Straight-line (haversine) distance is computed inside the
  // aggregation so it can be sorted before pagination; it preserves the
  // nearest-first order closely enough, and the card then shows road distance.
  const sortMap = {
    rating: { rating: -1, ratingCount: -1 },
    time: { estimatedDeliveryMin: 1, rating: -1 },
  };
  if (sort === 'distance' && customerCoords) {
    const [custLng, custLat] = customerCoords;
    const rad = (v) => ({ $degreesToRadians: v });
    const restLng = { $arrayElemAt: ['$location.coordinates', 0] };
    const restLat = { $arrayElemAt: ['$location.coordinates', 1] };
    const sinSq = (v) => ({ $pow: [{ $sin: { $divide: [v, 2] } }, 2] });
    const dLat = rad({ $subtract: [restLat, custLat] });
    const dLng = rad({ $subtract: [restLng, custLng] });
    const a = {
      $add: [
        sinSq(dLat),
        { $multiply: [{ $cos: rad(custLat) }, { $cos: rad(restLat) }, sinSq(dLng)] },
      ],
    };
    addFields.__straightKm = {
      $cond: [
        { $and: [{ $isArray: '$location.coordinates' }, { $gte: [{ $size: '$location.coordinates' }, 2] }] },
        {
          $multiply: [
            2 * 6371,
            { $atan2: [{ $sqrt: a }, { $sqrt: { $subtract: [1, a] } }] },
          ],
        },
        1e9, // restaurants without a location sort last
      ],
    };
    sortMap.distance = { __straightKm: 1, rating: -1 };
  }

  // Every sort keeps online-first as the leading key. The default
  // ('recommended') is the performance ranking: legacy explicit position, then
  // pinned, then featured, then performance score (with the sponsored boost),
  // then the legacy admin knobs.
  const groupSort = sort === 'recommended' || !sortMap[sort]
    ? { __isOpen: -1, __homeOrder: 1, __pinned: -1, isFeatured: -1, __rankScore: -1, displayPriority: -1, rating: -1, createdAt: -1 }
    : { __isOpen: -1, ...sortMap[sort] };

  const [result] = await Restaurant.aggregate([
    { $match: filter },
    { $addFields: addFields },
    {
      $facet: {
        total: [{ $count: 'n' }],
        data: [
          { $sort: groupSort },
          { $skip: skip },
          { $limit: limit },
          { $project: { ...CUSTOMER_LIST_PROJECTION, __isOpen: 1, __pinned: 1, __sponsored: 1, __rankScore: 1 } },
        ],
      },
    },
  ]);

  const total = (result && result.total && result.total[0] && result.total[0].n) || 0;
  const restaurants = (result && result.data) || [];

  // Attach provider-backed road distance for customer-facing cards. The
  // serviceability radius remains the existing geographic radius check; road
  // distance is a separate customer display/pricing input and is never
  // substituted with browser-side Haversine.
  const prepared = restaurants.map((restaurant, index) => {
    const view = withOperationalAvailability(restaurant, now, hoursContext);
    const withDistance = withServiceability(view, customerCoords);
    return { restaurant, withDistance, index };
  });

  // Keep provider concurrency bounded so a 20-card home page cannot create a
  // burst of simultaneous routing calls. routeService/Ola cache handles repeats.
  const roadDistanceById = new Map();
  if (customerCoords) {
    const queue = prepared.filter(({ restaurant }) =>
      Array.isArray(restaurant.location?.coordinates) &&
      restaurant.location.coordinates.length >= 2
    );
    const concurrency = 4;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (cursor < queue.length) {
        const item = queue[cursor++];
        const coords = item.restaurant.location.coordinates;
        try {
          const route = await resolveRoute(coords, customerCoords, {
            cacheKey: `restaurant-card:${String(item.restaurant._id)}:r2c`,
          });
          roadDistanceById.set(String(item.restaurant._id), route);
        } catch (_) {
          // resolveRoute is designed not to reject; preserve the existing
          // conservative estimate if a future provider implementation throws.
        }
      }
    });
    await Promise.all(workers);
  }

  res.json({
    success: true,
    page: Number(page),
    pages: Math.ceil(total / limit),
    total,
    data: prepared.map(({ restaurant, withDistance, index }) => {
      const roadRoute = roadDistanceById.get(String(restaurant._id));
      // 'unavailable' means a coordinate was missing/invalid: no distance is
      // known, so do not present it as a real 0 m.
      const roadDistanceKm = roadRoute && roadRoute.source !== 'unavailable' &&
        Number.isFinite(Number(roadRoute.distanceKm))
        ? Number(roadRoute.distanceKm)
        : null;
      return {
        ...withDistance,
        // distanceKm is the canonical customer-facing road distance whenever
        // a route could be resolved. Keep straightLineDistanceKm separately
        // for geographic radius/serviceability diagnostics.
        straightLineDistanceKm: withDistance.distanceKm,
        distanceKm: roadDistanceKm ?? withDistance.distanceKm,
        roadDistanceKm,
        distanceSource: roadRoute?.source || 'haversine_estimate',
        distanceDegraded: roadRoute ? roadRoute.degraded === true : true,
        rankPosition: skip + index + 1,
        online: restaurant.__isOpen === true,
        orderable: restaurant.__isOpen === true,
        performanceScore: Number(restaurant.performance?.score) || 0,
        featured: restaurant.isFeatured === true,
        pinned: restaurant.__pinned === true,
        sponsored: restaurant.__sponsored === true,
        sponsoredLabel: restaurant.__sponsored === true ? (restaurant.sponsorLabel || 'Sponsored') : '',
        serviceable: withDistance.serviceable,
      };
    }),
  });
});

const getServiceability = asyncHandler(async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ success: false, message: 'Valid location coordinates are required.' });
  }

  // This is intentionally a tiny, indexed query. The customer does not need
  // the complete restaurant payload just to decide whether the marketplace
  // should open. The Restaurant.location 2dsphere index makes this much
  // cheaper than downloading every restaurant and calculating distances in
  // the browser.
  const nearest = await Restaurant.aggregate([
    {
      $geoNear: {
        near: { type: 'Point', coordinates: [lng, lat] },
        key: 'location',
        distanceField: 'distanceMeters',
        spherical: true,
        maxDistance: 10000,
        query: { isActive: true, approvalStatus: 'approved' },
      },
    },
    { $limit: 1 },
    { $project: { _id: 1, distanceMeters: 1 } },
  ]);

  const nearestDistanceKm = nearest.length
    ? Number((Number(nearest[0].distanceMeters || 0) / 1000).toFixed(2))
    : null;

  return res.json({
    success: true,
    data: {
      serviceable: nearest.length > 0,
      maxDeliveryDistanceKm: 10,
      nearestDistanceKm,
    },
  });
});

const getRestaurantById = asyncHandler(async (req, res) => {
  // 🔧 CHANGE (Restaurant Availability): was `{ isOpen: true }`, which 404'd
  // closed restaurants entirely — but the customer detail page needs to be
  // able to render the "Closed / Opens Today 6:00 PM" state, so a closed
  // restaurant must still be fetchable. Only soft-deleted (isActive: false)
  // restaurants are excluded now.
  const restaurant = await Restaurant.findOne({ _id: req.params.id, isActive: true, approvalStatus: 'approved' });
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
  const now = new Date();
  const view = withOperationalAvailability(restaurant, now, getLocalContext(now));
  // Availability classification + ranking metadata come from the same backend
  // services the listing uses, so the detail page and the list can never
  // disagree about whether a restaurant is orderable.
  const { classifyRestaurantAvailability } = require('../services/restaurantAvailability');
  const availability = classifyRestaurantAvailability(view, now);
  res.json({
    success: true,
    data: {
      ...view,
      availabilityStatus: availability.class,
      orderable: availability.orderable,
      performanceScore: Number(restaurant.performance?.score) || 0,
      featured: restaurant.isFeatured === true,
      sponsored: restaurant.isSponsored === true,
      sponsoredLabel: restaurant.isSponsored ? (restaurant.sponsorLabel || 'Sponsored') : '',
      availabilityInfo: availability,
    },
  });
});

const getMenu = asyncHandler(async (req, res) => {
  // 🔧 CHANGE (Menu Item Availability): was `{ inStock: true }`, which hid
  // out-of-stock items entirely. The customer menu page needs to render
  // unavailable items grayed out with a dark overlay and a disabled "Unavailable"
  // button rather than hide them, so they must still be returned — `inStock` is
  // included on every item for the frontend to key off.
  // (Discovery/browse endpoints — getUnder99Items, searchRestaurants — are left
  // filtering to inStock-only, unchanged, same as isOpen on the restaurant side.)
  // PERFORMANCE: lean documents (no hydration / toJSON pass) + the same
  // schema defaults hydration used to add. Same fields, same order, same
  // grouping; out-of-stock items are still returned.
  const items = await MenuItem.find({
    restaurantId: req.params.id,
    isActive: { $ne: false },
    $or: [{ approvalStatus: 'approved' }, { approvalStatus: { $exists: false } }],
  }).sort({ category: 1, name: 1 }).lean();
  for (const item of items) applyMenuItemDefaults(item);

  const groupedMenu = items.reduce((acc, item) => {
    const cat = item.category || "Recommended";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(item);
    return acc;
  }, {});

  res.json({
    success: true,
    count: items.length,
    data: groupedMenu
  });
});

// ── ₹99 Store: short response cache + single-flight ───────────────────────
// GET /restaurants/under99 is identical for every caller (no user data), runs
// on every home-screen load, and is the heaviest public response because it
// carries each qualifying restaurant's COMPLETE menu. Under concurrency the
// same three queries + a large JSON build were repeated for every customer.
//
//  • Single-flight: requests that arrive while a build is running share it.
//  • Short TTL (UNDER99_CACHE_TTL_MS, default 10000 ms; 0 disables caching):
//    the finished payload is reused until it expires.
//  • Invalidation: every menu/restaurant write handled by THIS controller
//    clears the cache immediately (see invalidateUnder99Cache() calls below).
//    Writes made elsewhere (other controllers, other instances, direct DB
//    edits) become visible within the TTL.
//  • Safety: this is a browse listing only. POST /cart/add still re-reads the
//    Menu + Restaurant documents and enforces inStock / open / price, and
//    checkout re-verifies again, so a briefly stale card can never add a
//    stale price or an unavailable item to a cart.
const UNDER99_CACHE_TTL_MS = (() => {
  const raw = process.env.UNDER99_CACHE_TTL_MS;
  if (raw === undefined || String(raw).trim() === '') return 10000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 10000;
})();

const under99Cache = { payload: null, expiresAt: 0, inFlight: null, generation: 0 };

function invalidateUnder99Cache() {
  under99Cache.generation += 1;   // a build already running must not be stored
  under99Cache.payload = null;
  under99Cache.expiresAt = 0;
  under99Cache.inFlight = null;   // later requests start a fresh build
}

async function buildUnder99Payload() {
  // The 99 Store is restaurant-led: a restaurant qualifies when it has at
  // least one in-stock item priced at <= ₹99. Once qualified, the card gets
  // the restaurant's COMPLETE menu so the customer can horizontally browse
  // from lowest -> highest price and add any available item without making
  // one API request per restaurant.
  // PERFORMANCE: distinct() returns each qualifying restaurantId once instead
  // of one document per qualifying menu item (same set, far less transfer).
  const qualifyingRestaurantIds = await MenuItem.distinct('restaurantId', {
    price: { $lte: 99 },
    inStock: true,
    isActive: { $ne: false },
    $or: [{ approvalStatus: 'approved' }, { approvalStatus: { $exists: false } }],
  });

  const restaurantIds = [...new Set(
    qualifyingRestaurantIds
      .filter(Boolean)
      .map(id => id.toString())
  )];

  if (!restaurantIds.length) {
    return { success: true, count: 0, data: [] };
  }

  const visibleRestaurants = await Restaurant.find({
    _id: { $in: restaurantIds },
    isActive: true,
    approvalStatus: 'approved',
    $or: [
      { 'availability.isOpen': true },
      { isOpen: true },
      // Automatic-hours restaurants are evaluated in application code below;
      // persisted isOpen can be stale because schedules never write on a timer.
      { 'availability.autoHours': true }
    ],
  })
    .select([
      'name',
      'image',
      'images',
      'rating',
      'ratingCount',
      'estimatedDeliveryMin',
      'estimatedDeliveryMax',
      'time',
      'cuisine',
      'cuisineDisplay',
      'offer',
      'freeDeliveryAbove',
      'freeDeliveryEnabled',
      'deliveryFee',
      'isOpen',
      'availability',
      'openingHours',
    ].join(' '))
    .lean();

  const under99Now = new Date();
  const under99Context = getLocalContext(under99Now);
  const orderableVisibleRestaurants = visibleRestaurants.filter(restaurant =>
    operationalStatus(restaurant, under99Now, under99Context).open
  );
  visibleRestaurants.splice(0, visibleRestaurants.length, ...orderableVisibleRestaurants);

  if (!visibleRestaurants.length) {
    return { success: true, count: 0, data: [] };
  }

  const visibleRestaurantIds = visibleRestaurants.map(r => r._id);

  // Return every menu item, including out-of-stock items. This lets the
  // 99 Store card represent the restaurant's whole menu while the frontend
  // can disable the ADD control for unavailable items.
  const menuItems = await MenuItem.find({
    restaurantId: { $in: visibleRestaurantIds },
    isActive: { $ne: false },
    $or: [{ approvalStatus: 'approved' }, { approvalStatus: { $exists: false } }],
  })
    .select([
      'restaurantId',
      'name',
      'description',
      'price',
      'originalPrice',
      'image',
      'isVeg',
      'category',
      'isUnder99',
      'isBestseller',
      'isRecommended',
      'inStock',
      'customizations',
      'sortOrder',
    ].join(' '))
    .sort({ price: 1, sortOrder: 1, name: 1 })
    .lean();

  const menusByRestaurant = new Map();
  for (const item of menuItems) {
    const key = item.restaurantId.toString();
    if (!menusByRestaurant.has(key)) menusByRestaurant.set(key, []);

    const price = Number(item.price);
    const originalPrice = Number(item.originalPrice);
    const hasValidDiscount = Number.isFinite(originalPrice) && originalPrice > price;

    menusByRestaurant.get(key).push({
      id: item._id,
      name: item.name,
      description: item.description || '',
      price,
      originalPrice: hasValidDiscount ? originalPrice : null,
      discountPercent: hasValidDiscount
        ? Math.round(((originalPrice - price) / originalPrice) * 100)
        : null,
      image: item.image || '',
      isVeg: Boolean(item.isVeg),
      category: item.category || 'Recommended',
      isUnder99: price <= 99,
      isBestseller: Boolean(item.isBestseller),
      isRecommended: Boolean(item.isRecommended),
      inStock: item.inStock !== false,
      customizations: item.customizations || [],
    });
  }

  const data = visibleRestaurants
    .map(restaurant => {
      const key = restaurant._id.toString();
      const menu = menusByRestaurant.get(key) || [];
      if (!menu.length) return null;

      const restaurantView = withOperationalAvailability(restaurant, under99Now, under99Context);
      return {
        restaurant: {
          id: restaurant._id,
          name: restaurant.name,
          isOpen: restaurantView.isOpen,
          availability: restaurantView.availability,
          openingHours: restaurantView.openingHours,
          operational: restaurantView.operational,
          image: restaurant.image || restaurant.images?.[0] || '',
          images: restaurant.images || [],
          rating: restaurant.rating,
          ratingCount: restaurant.ratingCount,
          deliveryTime: restaurant.time || `${restaurant.estimatedDeliveryMin}-${restaurant.estimatedDeliveryMax} mins`,
          estimatedDeliveryMin: restaurant.estimatedDeliveryMin,
          estimatedDeliveryMax: restaurant.estimatedDeliveryMax,
          businessType: restaurant.businessType || 'restaurant',
          deliveryMode: restaurant.deliveryMode || 'eatswada_rider',
          // Stored `distance` is a static seed value, not the customer's real
          // distance, so it is no longer returned.
          distance: '',
          cuisine: restaurant.cuisineDisplay || (restaurant.cuisine || []).join(', '),
          offer: restaurant.offer || '',
          freeDeliveryAbove: restaurant.freeDeliveryEnabled ? restaurant.freeDeliveryAbove : null,
          deliveryFee: restaurant.deliveryFee,
        },
        menu,
        // The first item is always the cheapest because the query is sorted
        // by price, then sortOrder, then name.
        cheapestPrice: menu[0].price,
        menuCount: menu.length,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.cheapestPrice - b.cheapestPrice);

  return {
    success: true,
    count: data.length,
    data,
  };
}

function loadUnder99Payload() {
  if (under99Cache.payload && Date.now() < under99Cache.expiresAt) {
    return Promise.resolve(under99Cache.payload);
  }
  if (under99Cache.inFlight) return under99Cache.inFlight;

  const generation = under99Cache.generation;
  const build = buildUnder99Payload()
    .then((payload) => {
      if (UNDER99_CACHE_TTL_MS > 0 && under99Cache.generation === generation) {
        under99Cache.payload = payload;
        under99Cache.expiresAt = Date.now() + UNDER99_CACHE_TTL_MS;
      }
      return payload;
    })
    .finally(() => {
      if (under99Cache.inFlight === build) under99Cache.inFlight = null;
    });
  under99Cache.inFlight = build;
  return build;
}

const getUnder99Items = asyncHandler(async (req, res) => {
  try {
    // Failures are never cached; the next request retries the build.
    res.json(await loadUnder99Payload());
  } catch (error) {
    console.error('99 Store menu fetch failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch 99 store items',
    });
  }
});

const searchRestaurants = asyncHandler(async (req, res) => {
  const rawQ = String(req.query.q || '').trim();
  const scope = String(req.query.scope || 'home').trim().toLowerCase();
  const restaurantId = String(req.query.restaurantId || '').trim();

  if (rawQ.length < 2) {
    return res.status(400).json({ success: false, message: 'Query must be at least 2 characters' });
  }
  if (rawQ.length > 80) {
    return res.status(400).json({ success: false, message: 'Query is too long.' });
  }

  const allowedScopes = new Set(['home', 'under99', 'restaurant']);
  if (!allowedScopes.has(scope)) {
    return res.status(400).json({ success: false, message: 'Invalid search scope' });
  }

  if (scope === 'restaurant' && !mongoose.Types.ObjectId.isValid(restaurantId)) {
    return res.status(400).json({ success: false, message: 'Valid restaurantId is required for restaurant search' });
  }

  // Keep search input safe for regex and cap result work. This endpoint is an
  // autocomplete/search-surface API, not a full catalogue export.
  const regex = new RegExp(escapeRegex(rawQ), 'i');

  try {
    const menuFilter = {
      inStock: true,
      isActive: { $ne: false },
      $and: [
        { $or: [{ approvalStatus: 'approved' }, { approvalStatus: { $exists: false } }] },
        { $or: [{ name: regex }, { category: regex }, { description: regex }] },
      ],
    };

    if (scope === 'under99') {
      menuFilter.price = { $lte: 99 };
    }

    if (scope === 'restaurant') {
      menuFilter.restaurantId = restaurantId;
    }

    // Restaurant search is intentionally no longer part of the customer
    // homepage search response. The homepage search surface is dish-first.
    // Restaurant search remains available elsewhere through the dedicated
    // restaurant browse/search UI if needed.
    //
    // PERFORMANCE: the dish query and the "which restaurants are currently
    // customer-visible/orderable" query are independent, so they now run in
    // parallel (one round trip instead of two). The visibility rules are the
    // same as before; items are still ranked and capped at 30 FIRST and then
    // dropped if their restaurant is not visible, so the result is identical.
    const visibleRestaurantFilter = {
      isActive: true,
      approvalStatus: 'approved',
      $or: [
        { 'availability.isOpen': true },
        { isOpen: true },
        { 'availability.autoHours': true },
      ],
    };
    if (scope === 'restaurant') visibleRestaurantFilter._id = restaurantId;

    const [menuItems, restaurants] = await Promise.all([
      MenuItem.find(menuFilter)
        .select([
          '_id',
          'restaurantId',
          'name',
          'description',
          'price',
          'originalPrice',
          'image',
          'isVeg',
          'category',
          'isBestseller',
          'isRecommended',
          'inStock',
        ].join(' '))
        .sort({ isBestseller: -1, isRecommended: -1, sortOrder: 1, name: 1 })
        .limit(30)
        .lean(),
      Restaurant.find(visibleRestaurantFilter)
        .select('_id name image images rating ratingCount estimatedDeliveryMin estimatedDeliveryMax time cuisine cuisineDisplay businessType deliveryMode isOpen availability openingHours')
        .lean(),
    ]);

    if (!menuItems.length) {
      return res.json({
        success: true,
        scope,
        query: rawQ,
        count: 0,
        data: { menuItems: [] },
      });
    }

    const searchNow = new Date();
    const searchContext = getLocalContext(searchNow);
    const restaurantMap = new Map(restaurants
      .filter(r => operationalStatus(r, searchNow, searchContext).open)
      .map(r => [String(r._id), withOperationalAvailability(r, searchNow, searchContext)]));

    // Only return items whose restaurant is currently customer-visible/orderable.
    const data = menuItems
      .map(item => {
        const restaurant = restaurantMap.get(String(item.restaurantId));
        if (!restaurant) return null;

        return {
          id: item._id,
          restaurantId: restaurant._id,
          name: item.name,
          description: item.description || '',
          price: Number(item.price),
          originalPrice: Number.isFinite(Number(item.originalPrice))
            ? Number(item.originalPrice)
            : null,
          image: item.image || '',
          isVeg: Boolean(item.isVeg),
          category: item.category || 'Recommended',
          isBestseller: Boolean(item.isBestseller),
          isRecommended: Boolean(item.isRecommended),
          restaurant: {
            id: restaurant._id,
            name: restaurant.name,
            image: restaurant.image || restaurant.images?.[0] || '',
            rating: restaurant.rating,
            ratingCount: restaurant.ratingCount,
            deliveryTime: restaurant.time || `${restaurant.estimatedDeliveryMin}-${restaurant.estimatedDeliveryMax} mins`,
            cuisine: restaurant.cuisineDisplay || (restaurant.cuisine || []).join(', '),
            isOpen: restaurant.isOpen,
            availability: restaurant.availability,
            openingHours: restaurant.openingHours,
            operational: restaurant.operational,
          },
        };
      })
      .filter(Boolean);

    res.json({
      success: true,
      scope,
      query: rawQ,
      count: data.length,
      data: { menuItems: data },
    });
  } catch (error) {
    console.error('Search failed:', error);
    res.status(500).json({ success: false, message: 'Search failed' });
  }
});

const getCategories = asyncHandler(async (req, res) => {
  const cats = await Restaurant.distinct('categories', { isOpen: true, approvalStatus: 'approved' });
  res.json({ success: true, data: cats });
});

const normalizeRestaurantImages = (body) => {
  const incoming = Array.isArray(body.images) ? body.images : [];
  const images = incoming
    .map(v => String(v || '').trim())
    .filter(Boolean)
    .slice(0, 4);

  if (!images.length && body.image) images.push(String(body.image).trim());
  body.images = images;
  body.image = images[0] || '';
  return body;
};


const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

const getRestaurantReviews = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 10));
  const skip = (page - 1) * limit;

  const restaurantQuery = Restaurant.findOne({ _id: req.params.id, isActive: true, approvalStatus: 'approved' }).select('_id name rating ratingCount reviewCount');

  // PERFORMANCE:
  //  • The separate countDocuments() is gone: `total` is the sum of the score
  //    breakdown, which groups the exact same matched set (every review lands
  //    in exactly one score bucket), so the number is identical.
  //  • The review queries no longer wait for the restaurant lookup; both run
  //    together. The 404 contract is unchanged: if the restaurant is not
  //    customer-visible, nothing from the review queries is returned (and any
  //    review-query error is ignored, exactly as if it had never run).
  //  • Only the review fields the response uses are fetched.
  const loadReviews = (restaurantObjectId) => {
    const filter = { restaurant: restaurantObjectId, isVisible: true };
    return Promise.all([
      Review.find(filter)
        .select('score riderScore comment photos itemRatings createdAt user vendorReply')
        .populate('user', 'name avatar')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Review.aggregate([
        { $match: filter },
        { $group: { _id: '$score', count: { $sum: 1 } } },
        { $sort: { _id: -1 } }
      ]),
    ]);
  };

  let restaurant;
  let reviewResult;
  if (OBJECT_ID_HEX.test(String(req.params.id))) {
    const settledReviews = loadReviews(new mongoose.Types.ObjectId(String(req.params.id)))
      .then(value => ({ value }), error => ({ error }));
    [restaurant, reviewResult] = await Promise.all([restaurantQuery, settledReviews]);
  } else {
    // Malformed ids keep the original sequential path (same cast error / 404).
    restaurant = await restaurantQuery;
  }
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });

  if (!reviewResult) reviewResult = { value: await loadReviews(restaurant._id) };
  if (reviewResult.error) throw reviewResult.error;
  const [reviews, breakdown] = reviewResult.value;

  const counts = { 1:0, 2:0, 3:0, 4:0, 5:0 };
  let total = 0;
  breakdown.forEach(x => { counts[x._id] = x.count; total += x.count; });
  res.json({
    success: true,
    summary: { rating: total ? restaurant.rating : null, ratingCount: total, reviewCount: total, breakdown: counts },
    page, pages: Math.ceil(total / limit), total,
    data: reviews.map(r => ({
      id: r._id, score: r.score, riderScore: r.riderScore, comment: r.comment, photos: r.photos || [], itemRatings: r.itemRatings || [],
      createdAt: r.createdAt,
      vendorReply: r.vendorReply?.message ? { message: r.vendorReply.message, repliedAt: r.vendorReply.repliedAt } : null,
      customer: { name: r.user?.name || 'Customer', avatar: r.user?.avatar || '' },
      verified: true,
    }))
  });
});

const createRestaurant = asyncHandler(async (req, res) => {
  normalizeRestaurantImages(req.body);
  if (!req.body.cuisine && req.body.cuisineDisplay) req.body.cuisine = [req.body.cuisineDisplay]; 
  else if (!req.body.cuisine) req.body.cuisine = ['General'];
  if (!req.body.slug && req.body.name) req.body.slug = req.body.name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '') + '-' + Date.now();
  // COD is admin-controlled per restaurant. Vendor routes cannot create restaurants.
  if (req.user?.role !== 'admin') delete req.body.codEnabled;
  if (Object.prototype.hasOwnProperty.call(req.body, 'openingHours')) {
    const hoursCheck = buildOpeningHoursUpdate(req.body.openingHours);
    if (hoursCheck.error) return res.status(400).json({ success: false, message: hoursCheck.error });
    // Build a normalized schedule for creation without dot-path updates.
    const normalizedHours = { ...(req.body.openingHours || {}) };
    for (const [path, value] of Object.entries(hoursCheck.set)) {
      const [, day, field] = path.split('.');
      normalizedHours[day] = { ...(normalizedHours[day] || {}), [field]: value };
    }
    req.body.openingHours = normalizedHours;
  }
  const restaurant = await Restaurant.create(req.body);
  res.status(201).json({ success: true, data: restaurant });
});

const updateRestaurant = asyncHandler(async (req, res) => {
  const restaurantId = req.params.id || (req.user?.role === 'vendor' ? req.user.restaurantId : null);
  if (!restaurantId) return res.status(400).json({ success: false, message: 'Restaurant id is required.' });
  const existing = await Restaurant.findById(restaurantId);
  if (!existing) return res.status(404).json({ success: false, message: 'Restaurant not found' });

  // PERMISSIONS: CEO can edit any restaurant; vendor only their own.
  if (!canManageRestaurant(req.user, existing)) {
    return res.status(403).json({ success: false, message: 'Not authorized to manage this restaurant' });
  }
  // CEO/admin are allowed to control customer-facing presentation flags.
  // Vendors can edit their own operational restaurant data, but must never
  // be able to change admin-controlled ranking/badge fields.
  const isPrivilegedAdmin = req.user.role === 'admin' || req.user.role === 'ceo';

  // Admin may use the full restaurant editor. Vendor updates are deliberately
  // allow-listed so adding a new schema field later cannot accidentally turn
  // into a vendor privilege escalation.
  const VENDOR_EDITABLE = [
    'name', 'address', 'phone', 'contactNumber', 'image', 'images',
    'cuisine', 'cuisineDisplay', 'description', 'estimatedDeliveryMin',
    'availability', 'isOpen'
  ];
  const update = isPrivilegedAdmin
    ? { ...req.body }
    : Object.fromEntries(VENDOR_EDITABLE
        .filter((field) => Object.prototype.hasOwnProperty.call(req.body, field))
        .map((field) => [field, req.body[field]]));

  // Only admins can change the per-restaurant COD gate; vendor allow-list excludes it.
  if (!isPrivilegedAdmin) delete update.codEnabled;

  if (isPrivilegedAdmin) {
    // Explicitly persist both boolean flags, including false. This avoids
    // truthy/string handling issues and guarantees an unchecked admin box
    // can turn the badge off again.
    if (Object.prototype.hasOwnProperty.call(req.body, 'isBestSeller')) {
      update.isBestSeller = req.body.isBestSeller === true || req.body.isBestSeller === 'true';
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'isNearFast')) {
      update.isNearFast = req.body.isNearFast === true || req.body.isNearFast === 'true';
    }
  }

  // Weekly hours are validated and translated to safe dotted paths so partial
  // updates do not erase the other six days. Vendor ownership was checked above.
  if (Object.prototype.hasOwnProperty.call(update, 'openingHours')) {
    const hoursCheck = buildOpeningHoursUpdate(update.openingHours);
    if (hoursCheck.error) return res.status(400).json({ success: false, message: hoursCheck.error });
    delete update.openingHours;
    Object.assign(update, hoursCheck.set);
  }

  normalizeRestaurantImages(update);
  const restaurant = await Restaurant.findByIdAndUpdate(restaurantId, { $set: update }, { new: true, runValidators: true });
  invalidateUnder99Cache();
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
  res.json({ success: true, data: restaurant });
});

const deleteRestaurant = asyncHandler(async (req, res) => {
  // Permanent deletion is intentionally admin-only at the route level. Keep
  // this guard here too so the controller cannot accidentally be reused by a
  // future route without the same destructive-operation restriction.
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Only an admin can permanently delete a restaurant' });
  }

  const restaurantId = req.params.id;
  if (!restaurantId || !require('mongoose').isValidObjectId(restaurantId)) {
    return res.status(400).json({ success: false, message: 'Invalid restaurant ID' });
  }

  const session = await require('mongoose').startSession();
  try {
    let deletionSummary;

    await session.withTransaction(async () => {
      const restaurant = await Restaurant.findById(restaurantId).session(session);
      if (!restaurant) {
        const err = new Error('Restaurant not found');
        err.statusCode = 404;
        throw err;
      }

      // Never destroy a restaurant while an order is still operational. Orders
      // are the financial/source-of-truth records and must complete or be
      // cancelled before the restaurant can be permanently removed.
      const activeOrderCount = await Order.countDocuments({
        restaurant: restaurantId,
        status: { $nin: ['delivered', 'cancelled'] },
      }).session(session);

      if (activeOrderCount > 0) {
        const err = new Error(`Restaurant cannot be permanently deleted while ${activeOrderCount} order(s) are still active. Complete or cancel them first.`);
        err.statusCode = 409;
        throw err;
      }

      const [menuResult, reviewResult] = await Promise.all([
        MenuItem.deleteMany({ restaurantId }).session(session),
        Review.deleteMany({ restaurant: restaurantId }).session(session),
      ]);

      // Remove deleted menu items/restaurant references from customer carts so
      // a stale cart can never resurrect an item belonging to the deleted shop.
      await Cart.updateMany(
        { $or: [
          { 'items.restaurant': restaurantId },
          { restaurant: restaurantId },
        ] },
        {
          $pull: { items: { restaurant: restaurantId } },
          $set: { restaurant: null, restaurantName: '' },
        },
        { session }
      );

      // Detach the vendor account instead of deleting the User document. This
      // preserves the account/history and allows a future re-onboarding flow.
      // It is deactivated because a vendor without a restaurant cannot operate
      // the vendor portal for this deleted business.
      const vendorResult = await User.updateMany(
        { role: 'vendor', restaurantId },
        { $set: { restaurantId: null, isActive: false }, $inc: { tokenVersion: 1 } },
        { session }
      );

      // Remove the restaurant from every customer's favorites. This avoids
      // dangling savedRestaurants ObjectIds after hard deletion.
      const favoritesResult = await User.updateMany(
        { savedRestaurants: restaurantId },
        { $pull: { savedRestaurants: restaurantId } },
        { session }
      );

      // Keep a durable deletion audit record because the Restaurant document
      // itself is about to disappear. This preserves who deleted it, when,
      // which vendor owned it, and what dependent data was removed.
      await RestaurantDeletionAudit.create([{
        restaurantId: restaurant._id,
        restaurantName: restaurant.name,
        restaurantSlug: restaurant.slug,
        owner: restaurant.owner || null,
        deletedBy: req.user._id,
        deletedAt: new Date(),
        menuItemsDeleted: menuResult.deletedCount || 0,
        reviewsDeleted: reviewResult.deletedCount || 0,
        vendorAccountsDetached: vendorResult.modifiedCount || 0,
        cartsCleaned: 0, // MongoDB updateMany does not expose matched item counts per nested item.
        favoritesCleaned: favoritesResult.modifiedCount || 0,
      }], { session });

      const deleted = await Restaurant.deleteOne({ _id: restaurantId }).session(session);
      if (deleted.deletedCount !== 1) {
        const err = new Error('Restaurant deletion could not be completed');
        err.statusCode = 500;
        throw err;
      }

      deletionSummary = {
        restaurantId: String(restaurant._id),
        restaurantName: restaurant.name,
        menuItemsDeleted: menuResult.deletedCount || 0,
        reviewsDeleted: reviewResult.deletedCount || 0,
        vendorAccountsDetached: vendorResult.modifiedCount || 0,
        favoritesCleaned: favoritesResult.modifiedCount || 0,
      };
    });

    invalidateUnder99Cache();
    return res.json({
      success: true,
      message: 'Restaurant permanently deleted. Historical orders and financial records were preserved.',
      data: deletionSummary,
    });
  } catch (error) {
    if (error && error.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    throw error;
  } finally {
    await session.endSession();
  }
});

/**
 * PATCH /api/restaurants/:id/availability
 * Admin-only. Backward-compatible manual status updates also accept a weekly
 * `openingHours` schedule and `autoHours` flag for automatic hours management.
 */
const updateRestaurantAvailability = asyncHandler(async (req, res) => {
  const restaurant = await Restaurant.findById(req.params.id);
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });

  if (!canManageRestaurant(req.user, restaurant)) {
    return res.status(403).json({ success: false, message: 'Not authorized to manage this restaurant' });
  }

  const body = req.body || {};
  const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status');
  const hasHours = Object.prototype.hasOwnProperty.call(body, 'openingHours');
  const hasAutoHours = Object.prototype.hasOwnProperty.call(body, 'autoHours');
  const hasLegacyTimes = Object.prototype.hasOwnProperty.call(body, 'opensAt') || Object.prototype.hasOwnProperty.call(body, 'closesAt');
  if (!hasStatus && !hasHours && !hasAutoHours && !hasLegacyTimes) {
    return res.status(400).json({ success: false, message: 'Provide status, openingHours, autoHours, or legacy opening-time fields.' });
  }

  const allowedStatuses = ['open', 'closed_today', 'temporarily_closed', 'busy'];
  if (hasStatus && !allowedStatuses.includes(body.status)) {
    return res.status(400).json({ success: false, message: `status must be one of: ${allowedStatuses.join(', ')}` });
  }
  if (hasAutoHours && typeof body.autoHours !== 'boolean') {
    return res.status(400).json({ success: false, message: 'autoHours must be a boolean.' });
  }

  const update = {};
  if (hasStatus) {
    const status = body.status;
    const isOpen = status === 'open' || status === 'busy';
    update.isOpen = isOpen;
    update['availability.isOpen'] = isOpen;
    update['availability.status'] = status;
    update['availability.closedReason'] = isOpen ? '' : status;
  }

  if (hasAutoHours) update['availability.autoHours'] = body.autoHours;

  if (Object.prototype.hasOwnProperty.call(body, 'opensAt')) {
    if (body.opensAt !== '' && !validTime(body.opensAt)) {
      return res.status(400).json({ success: false, message: 'opensAt must use 24-hour HH:MM.' });
    }
    update['availability.opensAt'] = body.opensAt;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'closesAt')) {
    if (body.closesAt !== '' && !validTime(body.closesAt)) {
      return res.status(400).json({ success: false, message: 'closesAt must use 24-hour HH:MM.' });
    }
    update['availability.closesAt'] = body.closesAt;
  }

  if (hasHours) {
    const hoursCheck = buildOpeningHoursUpdate(body.openingHours);
    if (hoursCheck.error) return res.status(400).json({ success: false, message: hoursCheck.error });
    Object.assign(update, hoursCheck.set);
  }

  const updated = await Restaurant.findByIdAndUpdate(req.params.id, { $set: update }, { new: true, runValidators: true });
  invalidateUnder99Cache();
  const now = new Date();
  res.json({
    success: true,
    data: updated,
    operational: operationalStatus(updated, now, getLocalContext(now)),
  });
});

const addMenuItem = asyncHandler(async (req, res) => {
  const targetRestaurantId = req.params.id || req.body.restaurant || req.body.restaurantId;
  if (!targetRestaurantId) return res.status(400).json({ success: false, message: 'Restaurant ID is required' });

  const restaurant = await Restaurant.findById(targetRestaurantId);
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });

  // PERMISSIONS: CEO can add items to any restaurant; vendor only their own.
  if (!canManageRestaurant(req.user, restaurant)) {
    return res.status(403).json({ success: false, message: 'Not authorized to manage this restaurant\'s menu' });
  }

  // 🔧 FIX: Menu schema's field is `restaurantId`, not `restaurant`. Writing only
  // `restaurant` here meant Mongoose silently dropped it (not in schema), leaving
  // the required `restaurantId` unset — so the item never matched
  // GET /api/restaurants/:id/menu, which filters on restaurantId.
  const payload = { ...req.body, restaurantId: targetRestaurantId, restaurant: targetRestaurantId };
  if (payload.trackStock === true) {
    const quantity = Number(payload.stockQuantity ?? 0);
    if (!Number.isInteger(quantity) || quantity < 0) return res.status(400).json({ success:false, message:'stockQuantity must be a non-negative integer.' });
    payload.stockQuantity = quantity;
    payload.manualAvailability = payload.manualAvailability !== false && payload.inStock !== false;
    payload.inStock = payload.manualAvailability && quantity > 0;
  } else {
    payload.manualAvailability = payload.manualAvailability !== false && payload.inStock !== false;
    payload.inStock = payload.manualAvailability;
  }
  if (payload.originalPrice !== undefined && payload.originalPrice !== null && Number(payload.originalPrice) <= Number(payload.price)) {
    payload.originalPrice = null;
  }
  const item = await MenuItem.create(payload);
  if (item.price <= 99) { item.isUnder99 = true; await item.save(); }
  invalidateUnder99Cache();
  res.status(201).json({ success: true, data: item });
});

const updateMenuItem = asyncHandler(async (req, res) => {
  const existing = await MenuItem.findById(req.params.itemId);
  if (!existing) return res.status(404).json({ success: false, message: 'Menu item not found' });

  // PERMISSIONS: CEO can edit any menu item; vendor only items on their own
  // restaurant. Checked against the item's actual restaurantId (not the URL's
  // :id) so a vendor can't reach another restaurant's item by mismatching params.
  const restaurant = await Restaurant.findById(existing.restaurantId);
  if (!restaurant || !canManageRestaurant(req.user, restaurant)) {
    return res.status(403).json({ success: false, message: 'Not authorized to manage this menu item' });
  }

  const update = { ...req.body };
  if (update.stockQuantity !== undefined) {
    const quantity = Number(update.stockQuantity);
    if (!Number.isInteger(quantity) || quantity < 0) return res.status(400).json({ success:false, message:'stockQuantity must be a non-negative integer.' });
    update.stockQuantity = quantity;
  }
  if (typeof update.inStock === 'boolean' && update.manualAvailability === undefined) update.manualAvailability = update.inStock;
  const nextTrackStock = update.trackStock === undefined ? existing.trackStock : update.trackStock === true;
  const nextQuantity = update.stockQuantity === undefined ? Number(existing.stockQuantity || 0) : Number(update.stockQuantity);
  const nextManualAvailability = update.manualAvailability === undefined ? existing.manualAvailability !== false : update.manualAvailability === true;
  update.inStock = nextManualAvailability && (!nextTrackStock || nextQuantity > 0);
  update.manualAvailability = nextManualAvailability;
  if (update.originalPrice !== undefined && update.originalPrice !== null && Number(update.originalPrice) <= Number(update.price ?? existing.price)) {
    update.originalPrice = null;
  }
  const item = await MenuItem.findByIdAndUpdate(req.params.itemId, update, { new: true, runValidators: true });
  invalidateUnder99Cache();
  res.json({ success: true, data: item });
});

const deleteMenuItem = asyncHandler(async (req, res) => {
  const existing = await MenuItem.findById(req.params.itemId);
  if (!existing) return res.status(404).json({ success: false, message: 'Menu item not found' });

  const restaurant = await Restaurant.findById(existing.restaurantId);
  if (!restaurant || !canManageRestaurant(req.user, restaurant)) {
    return res.status(403).json({ success: false, message: 'Not authorized to manage this menu item' });
  }

  const item = await MenuItem.findByIdAndDelete(req.params.itemId);
  invalidateUnder99Cache();
  res.json({ success: true, message: 'Menu item deleted' });
});

/**
 * PATCH /api/restaurants/:id/menu/:itemId/availability
 * Body: { isAvailable: boolean }
 *
 * PERMISSIONS: CEO can mark any item In Stock/Out of Stock; vendor only
 * items on their own restaurant. `isAvailable` is the feature-facing name
 * from the spec — it's written to the existing `inStock` schema field
 * (kept as-is; see Menu.js "Vendor Toggle" comment) so nothing that already
 * reads `inStock` needs to change.
 */
const updateMenuItemAvailability = asyncHandler(async (req, res) => {
  const item = await MenuItem.findById(req.params.itemId);
  if (!item) return res.status(404).json({ success: false, message: 'Menu item not found' });

  const restaurant = await Restaurant.findById(item.restaurantId);
  if (!restaurant || !canManageRestaurant(req.user, restaurant)) {
    return res.status(403).json({ success: false, message: 'Not authorized to manage this menu item' });
  }

  const { isAvailable } = req.body;
  if (typeof isAvailable !== 'boolean') {
    return res.status(400).json({ success: false, message: 'isAvailable must be true or false' });
  }

  item.manualAvailability = isAvailable;
  item.inStock = isAvailable && (!item.trackStock || Number(item.stockQuantity || 0) > 0);
  await item.save();
  invalidateUnder99Cache();

  res.json({ success: true, data: item });
});

module.exports = {
  getRestaurants, getServiceability, getRestaurantById, getRestaurantReviews, getMenu, getUnder99Items,
  searchRestaurants, getCategories,
  createRestaurant, updateRestaurant, deleteRestaurant, updateRestaurantAvailability,
  addMenuItem, updateMenuItem, deleteMenuItem, updateMenuItemAvailability
};

const Restaurant = require('../models/Restaurant');
const MenuItem   = require('../models/Menu');
const asyncHandler = require('express-async-handler');
const Review = require('../models/Review');

/**
 * Restaurant-level authorization for Availability + Permissions feature:
 *  - Admin can manage every restaurant.
 *  - Vendor can only manage a restaurant they own.
 * Used by updateRestaurant, deleteRestaurant, and updateRestaurantAvailability.
 */
const canManageRestaurant = (user, restaurant) => {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return user.role === 'vendor' && restaurant.owner.toString() === user._id.toString();
};

const getRestaurants = asyncHandler(async (req, res) => {
  const { veg, category, search, sort = 'recommended', page = 1, limit = 20 } = req.query;
  
  // 🔧 FIX (Restaurant Availability): only exclude soft-deleted restaurants here.
  // Closed restaurants (isOpen: false) must still come back — the customer
  // homepage keeps them visible in the list, grayed out via availability /
  // closedReason, instead of hiding them. Filtering by isOpen at the query
  // level made that impossible since closed restaurants never reached the
  // frontend at all.
  const filter = { isActive: true }; 
  
  if (veg === 'true') filter.isVeg = true;
  if (category) filter.categories = { $in: [category] };
  if (search) filter.$text = { $search: search };
  
  const sortMap = {
    recommended: { homeOrder: 1, isFeatured: -1, displayPriority: -1, rating: -1, createdAt: -1 },
    rating: { rating: -1, ratingCount: -1 },
    time: { estimatedDeliveryMin: 1, rating: -1 },
    distance: { distanceMeters: 1, rating: -1 }
  };
  const sortOpt = sortMap[sort] || { rating: -1 };
  const skip = (Number(page) - 1) * Number(limit);
  
  let restaurants;
  let total;

  if (sort === 'recommended') {
    // `$ifNull` keeps older documents (created before homeOrder existed) in
    // the automatic bucket instead of letting a missing value outrank
    // explicit positions such as #1, #2, #3.
    [restaurants, total] = await Promise.all([
      Restaurant.aggregate([
        { $match: filter },
        { $addFields: { __homeOrder: { $ifNull: ['$homeOrder', 999999] } } },
        { $sort: { __homeOrder: 1, isFeatured: -1, displayPriority: -1, rating: -1, createdAt: -1 } },
        { $skip: skip },
        { $limit: Number(limit) },
        { $project: { __homeOrder: 0 } },
      ]),
      Restaurant.countDocuments(filter),
    ]);
  } else {
    [restaurants, total] = await Promise.all([
      Restaurant.find(filter).sort(sortOpt).skip(skip).limit(Number(limit)),
      Restaurant.countDocuments(filter),
    ]);
  }

  res.json({ success: true, page: Number(page), pages: Math.ceil(total / Number(limit)), total, data: restaurants });
});

const getRestaurantById = asyncHandler(async (req, res) => {
  // 🔧 CHANGE (Restaurant Availability): was `{ isOpen: true }`, which 404'd
  // closed restaurants entirely — but the customer detail page needs to be
  // able to render the "Closed / Opens Today 6:00 PM" state, so a closed
  // restaurant must still be fetchable. Only soft-deleted (isActive: false)
  // restaurants are excluded now.
  const restaurant = await Restaurant.findOne({ _id: req.params.id, isActive: true });
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
  res.json({ success: true, data: restaurant });
});

const getMenu = asyncHandler(async (req, res) => {
  // 🔧 CHANGE (Menu Item Availability): was `{ inStock: true }`, which hid
  // out-of-stock items entirely. The customer menu page needs to render
  // unavailable items grayed out with a dark overlay and a disabled "Unavailable"
  // button rather than hide them, so they must still be returned — `inStock` is
  // included on every item for the frontend to key off.
  // (Discovery/browse endpoints — getUnder99Items, searchRestaurants — are left
  // filtering to inStock-only, unchanged, same as isOpen on the restaurant side.)
  const items = await MenuItem.find({
    restaurantId: req.params.id,
  }).sort({ category: 1, name: 1 });

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

const getUnder99Items = asyncHandler(async (req, res) => {
  try {
    // 🔧 FIX: same mismatch as above — schema uses `inStock` (not `isAvailable`)
    // and `restaurantId` (not `restaurant`), so this endpoint always returned 0
    // items regardless of what was in the database.
    const items = await MenuItem.find({ price: { $lte: 149 }, inStock: true })
      .populate({ path: 'restaurantId', match: { isOpen: true }, select: 'name image rating' })
      .sort({ price: 1 })
      .limit(50);

    // Response shape kept identical to before (key still called "restaurant")
    // so the frontend doesn't need any changes.
    const validItems = items
      .filter(item => item.restaurantId != null)
      .map(item => {
        const obj = item.toObject();
        obj.restaurant = obj.restaurantId;
        return obj;
      });

    res.json({ success: true, count: validItems.length, data: validItems });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch 99 store items' });
  }
});

const searchRestaurants = asyncHandler(async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.status(400).json({ success: false, message: 'Query must be at least 2 characters' });
  const regex = new RegExp(q, 'i');
  try {
    const [restaurants, menuItems] = await Promise.all([
      Restaurant.find({ isOpen: true, $or: [{ name: regex }, { cuisineDisplay: regex }] }).limit(10),
      // 🔧 FIX: schema field is `inStock`, not `isAvailable` — same bug as above,
      // meant menu-item search results were always empty.
      MenuItem.find({ inStock: true, name: regex }).limit(20),
    ]);
    res.json({ success: true, data: { restaurants, menuItems } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Search failed' });
  }
});

const getCategories = asyncHandler(async (req, res) => {
  const cats = await Restaurant.distinct('categories', { isOpen: true });
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


const getRestaurantReviews = asyncHandler(async (req, res) => {
  const restaurant = await Restaurant.findOne({ _id: req.params.id, isActive: true }).select('_id name rating ratingCount reviewCount');
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 10));
  const skip = (page - 1) * limit;
  const filter = { restaurant: restaurant._id, isVisible: true };
  const [reviews, total, breakdown] = await Promise.all([
    Review.find(filter).populate('user', 'name avatar').sort({ createdAt: -1 }).skip(skip).limit(limit),
    Review.countDocuments(filter),
    Review.aggregate([
      { $match: filter },
      { $group: { _id: '$score', count: { $sum: 1 } } },
      { $sort: { _id: -1 } }
    ])
  ]);
  const counts = { 1:0, 2:0, 3:0, 4:0, 5:0 };
  breakdown.forEach(x => { counts[x._id] = x.count; });
  res.json({
    success: true,
    summary: { rating: total ? restaurant.rating : null, ratingCount: total, reviewCount: total, breakdown: counts },
    page, pages: Math.ceil(total / limit), total,
    data: reviews.map(r => ({
      id: r._id, score: r.score, riderScore: r.riderScore, comment: r.comment,
      createdAt: r.createdAt,
      customer: { name: r.user?.name || 'Customer', avatar: r.user?.avatar || '' },
      verified: true,
    }))
  });
});

const createRestaurant = asyncHandler(async (req, res) => {
  const body = { ...req.body };
  normalizeRestaurantImages(body);
  if (!body.cuisine && body.cuisineDisplay) body.cuisine = [body.cuisineDisplay];
  else if (!body.cuisine) body.cuisine = ['General'];
  if (!body.slug && body.name) {
    body.slug = body.name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '') + '-' + Date.now();
  }
  if (body.phone != null) body.phone = String(body.phone).trim();
  if (body.description != null) body.description = String(body.description).trim();

  const restaurant = await Restaurant.create(body);
  res.status(201).json({ success: true, data: restaurant });
});

const updateRestaurant = asyncHandler(async (req, res) => {
  const existing = await Restaurant.findById(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Restaurant not found' });

  // PERMISSIONS: Admin can edit any restaurant; vendor only their own.
  if (!canManageRestaurant(req.user, existing)) {
    return res.status(403).json({ success: false, message: 'Not authorized to manage this restaurant' });
  }
  // Field permissions are an ALLOW-LIST, not a deny-list.
  //
  // This used to start from { ...req.body } and delete six admin-only fields,
  // which left every other field in the schema writable by the vendor —
  // including `rating`, `ratingCount` and `reviewCount` (a vendor could award
  // themselves 5.0 with 900 reviews) and `location.coordinates`, `minOrder`,
  // `deliveryRadiusKm`, `freeDeliveryAbove` and `codEnabled` (moving the map
  // pin on top of the customer changes the distance-based delivery fee).
  //
  // Anything not named below is ignored. Adding a field to the schema no
  // longer silently grants vendors write access to it.
  const VENDOR_EDITABLE = [
    'name', 'description', 'phone', 'address', 'image', 'coverImage', 'images',
    'cuisine', 'cuisineDisplay', 'categories', 'isVeg',
    'openingHours', 'availability', 'isOpen', 'closedReason',
  ];

  const ADMIN_ONLY_EDITABLE = [
    'owner', 'isActive', 'isFeatured', 'isBestSeller', 'isNearFast',
    'homeOrder', 'displayPriority', 'rating', 'ratingCount', 'reviewCount',
    'location', 'minOrder', 'deliveryRadiusKm', 'codEnabled',
    'freeDeliveryEnabled', 'freeDeliveryAbove', 'offer', 'commissionRate',
  ];

  const isPrivilegedAdmin = req.user.role === 'admin';
  const allowedFields = isPrivilegedAdmin
    ? [...VENDOR_EDITABLE, ...ADMIN_ONLY_EDITABLE]
    : VENDOR_EDITABLE;

  const update = {};
  for (const key of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) update[key] = req.body[key];
  }

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

  normalizeRestaurantImages(update);
  if (update.phone != null) update.phone = String(update.phone).trim();
  if (update.description != null) update.description = String(update.description).trim();

  const restaurant = await Restaurant.findByIdAndUpdate(req.params.id, { $set: update }, { new: true, runValidators: true });
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
  res.json({ success: true, data: restaurant });
});

const deleteRestaurant = asyncHandler(async (req, res) => {
  const existing = await Restaurant.findById(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Restaurant not found' });

  // PERMISSIONS: Admin can deactivate any restaurant; vendor only their own.
  if (!canManageRestaurant(req.user, existing)) {
    return res.status(403).json({ success: false, message: 'Not authorized to manage this restaurant' });
  }

  // 🔧 CHANGE (Restaurant Availability): also set availability.isOpen/closedReason
  // alongside the existing isOpen:false, so the two stay consistent instead of
  // a deactivated restaurant showing as "Open" via the new availability field.
  const restaurant = await Restaurant.findByIdAndUpdate(
    req.params.id,
    {
      isActive: false,
      isOpen: false,
      'availability.isOpen': false,
      'availability.closedReason': 'temporarily_closed',
    },
    { new: true }
  );
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
  // 🔧 FIX: Menu schema uses `restaurantId` (not `restaurant`) and `inStock`
  // (not `isAvailable`). With the old names this matched 0 documents, so menu
  // items never actually got deactivated when a restaurant was removed.
  await MenuItem.updateMany({ restaurantId: req.params.id }, { inStock: false });
  res.json({ success: true, message: 'Restaurant and menu successfully deactivated' });
});

/**
 * PATCH /api/restaurants/:id/availability
 * Body: { status: 'open' | 'closed_today' | 'temporarily_closed', opensAt?, closesAt?, autoHours? }
 *
 * PERMISSIONS: Admin can open/close any restaurant; vendor only their own.
 * opensAt/closesAt/autoHours are accepted and stored now (for the future
 * auto-hours feature) but are not evaluated yet — see Restaurant.js.
 */
const updateRestaurantAvailability = asyncHandler(async (req, res) => {
  const restaurant = await Restaurant.findById(req.params.id);
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });

  if (!canManageRestaurant(req.user, restaurant)) {
    return res.status(403).json({ success: false, message: 'Not authorized to manage this restaurant' });
  }

  const { opensAt, closesAt, autoHours } = req.body;
  const status = req.body.status || req.body.availabilityStatus;
  const validStatuses = ['open', 'closed_today', 'temporarily_closed'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ success: false, message: `status must be one of: ${validStatuses.join(', ')}` });
  }

  const isOpen = status === 'open';

  // isOpen is set both at the top level (legacy — read by getRestaurantById,
  // getCategories, searchRestaurants, sort, etc.) and inside availability
  // (new source of truth). findByIdAndUpdate skips the model's pre-validate
  // hook, so both must be set explicitly here — see Restaurant.js comments.
  const update = {
    isOpen,
    'availability.isOpen': isOpen,
    'availability.closedReason': isOpen ? '' : status,
  };
  if (typeof opensAt === 'string') update['availability.opensAt'] = opensAt;
  if (typeof closesAt === 'string') update['availability.closesAt'] = closesAt;
  if (typeof autoHours === 'boolean') update['availability.autoHours'] = autoHours;

  const updated = await Restaurant.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
  res.json({ success: true, data: updated });
});

const addMenuItem = asyncHandler(async (req, res) => {
  const targetRestaurantId = req.params.id || req.body.restaurant || req.body.restaurantId;
  if (!targetRestaurantId) return res.status(400).json({ success: false, message: 'Restaurant ID is required' });

  const restaurant = await Restaurant.findById(targetRestaurantId);
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });

  // PERMISSIONS: Admin can add items to any restaurant; vendor only their own.
  if (!canManageRestaurant(req.user, restaurant)) {
    return res.status(403).json({ success: false, message: 'Not authorized to manage this restaurant\'s menu' });
  }

  // 🔧 FIX: Menu schema's field is `restaurantId`, not `restaurant`. Writing only
  // `restaurant` here meant Mongoose silently dropped it (not in schema), leaving
  // the required `restaurantId` unset — so the item never matched
  // GET /api/restaurants/:id/menu, which filters on restaurantId.
  const payload = { ...req.body, restaurantId: targetRestaurantId, restaurant: targetRestaurantId };
  if (payload.originalPrice !== undefined && payload.originalPrice !== null && Number(payload.originalPrice) <= Number(payload.price)) {
    payload.originalPrice = null;
  }
  const item = await MenuItem.create(payload);
  if (item.price <= 99) { item.isUnder99 = true; await item.save(); }
  res.status(201).json({ success: true, data: item });
});

const updateMenuItem = asyncHandler(async (req, res) => {
  const existing = await MenuItem.findById(req.params.itemId);
  if (!existing) return res.status(404).json({ success: false, message: 'Menu item not found' });

  // PERMISSIONS: Admin can edit any menu item; vendor only items on their own
  // restaurant. Checked against the item's actual restaurantId (not the URL's
  // :id) so a vendor can't reach another restaurant's item by mismatching params.
  const restaurant = await Restaurant.findById(existing.restaurantId);
  if (!restaurant || !canManageRestaurant(req.user, restaurant)) {
    return res.status(403).json({ success: false, message: 'Not authorized to manage this menu item' });
  }

  const update = { ...req.body };
  if (update.originalPrice !== undefined && update.originalPrice !== null && Number(update.originalPrice) <= Number(update.price ?? existing.price)) {
    update.originalPrice = null;
  }
  const item = await MenuItem.findByIdAndUpdate(req.params.itemId, update, { new: true, runValidators: true });
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
  res.json({ success: true, message: 'Menu item deleted' });
});

/**
 * PATCH /api/restaurants/:id/menu/:itemId/availability
 * Body: { isAvailable: boolean }
 *
 * PERMISSIONS: Admin can mark any item In Stock/Out of Stock; vendor only
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

  item.inStock = isAvailable;
  await item.save();

  res.json({ success: true, data: item });
});

module.exports = {
  getRestaurants, getRestaurantById, getRestaurantReviews, getMenu, getUnder99Items,
  searchRestaurants, getCategories,
  createRestaurant, updateRestaurant, deleteRestaurant, updateRestaurantAvailability,
  addMenuItem, updateMenuItem, deleteMenuItem, updateMenuItemAvailability
};

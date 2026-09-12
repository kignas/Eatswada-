const Restaurant = require('../models/Restaurant');
const MenuItem   = require('../models/Menu');
const asyncHandler = require('express-async-handler');
const Review = require('../models/Review');
const Order = require('../models/Order');
const Cart = require('../models/Cart');
const User = require('../models/User');
const RestaurantDeletionAudit = require('../models/RestaurantDeletionAudit');

const clampPage = (value, fallback = 1) => Math.max(1, Number(value) || fallback);
const clampLimit = (value, fallback = 20, max = 100) => Math.min(max, Math.max(1, Number(value) || fallback));
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

  const sortMap = {
    recommended: { homeOrder: 1, isFeatured: -1, displayPriority: -1, rating: -1, createdAt: -1 },
    rating: { rating: -1, ratingCount: -1 },
    time: { estimatedDeliveryMin: 1, rating: -1 },
    distance: { distanceMeters: 1, rating: -1 }
  };
  const sortOpt = sortMap[sort] || { rating: -1 };
  const skip = (page - 1) * limit;

  // Fetch one availability group at a time. `availability.isOpen` is the
  // canonical field; the top-level `isOpen` is only a legacy mirror.
  const openFilter = { ...filter, 'availability.isOpen': true };
  const closedFilter = { ...filter, 'availability.isOpen': { $ne: true } };

  const findGroup = async (groupFilter, groupSkip, groupLimit) => {
    if (groupLimit <= 0) return [];

    if (sort === 'recommended') {
      // Keep the existing recommended-order semantics, including the explicit
      // fallback for old documents that do not have homeOrder.
      return Restaurant.aggregate([
        { $match: groupFilter },
        { $addFields: { __homeOrder: { $ifNull: ['$homeOrder', 999999] } } },
        { $sort: { __homeOrder: 1, isFeatured: -1, displayPriority: -1, rating: -1, createdAt: -1 } },
        { $skip: groupSkip },
        { $limit: groupLimit },
        { $project: { __homeOrder: 0 } }
      ]);
    }

    return Restaurant.find(groupFilter)
      .sort(sortOpt)
      .skip(groupSkip)
      .limit(groupLimit);
  };

  const [openCount, closedCount] = await Promise.all([
    Restaurant.countDocuments(openFilter),
    Restaurant.countDocuments(closedFilter)
  ]);

  const total = openCount + closedCount;
  let restaurants = [];

  // Pagination is applied to the combined [open..., closed...] sequence.
  if (skip < openCount) {
    const openTake = Math.min(limit, openCount - skip);
    const openRows = await findGroup(openFilter, skip, openTake);
    restaurants = openRows;

    const remaining = limit - openRows.length;
    if (remaining > 0) {
      const closedRows = await findGroup(closedFilter, 0, remaining);
      restaurants = restaurants.concat(closedRows);
    }
  } else {
    const closedSkip = skip - openCount;
    restaurants = await findGroup(closedFilter, closedSkip, limit);
  }

  res.json({
    success: true,
    page: Number(page),
    pages: Math.ceil(total / limit),
    total,
    data: restaurants
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
      .populate({ path: 'restaurantId', match: { isOpen: true, approvalStatus: 'approved' }, select: 'name image rating' })
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
  const rawQ = String(req.query.q || '').trim();
  if (rawQ.length < 2) return res.status(400).json({ success: false, message: 'Query must be at least 2 characters' });
  if (rawQ.length > 80) return res.status(400).json({ success: false, message: 'Query is too long.' });
  const regex = new RegExp(escapeRegex(rawQ), 'i');
  try {
    const [restaurants, menuItems] = await Promise.all([
      Restaurant.find({ isOpen: true, approvalStatus: 'approved', $or: [{ name: regex }, { cuisineDisplay: regex }] }).limit(10),
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


const getRestaurantReviews = asyncHandler(async (req, res) => {
  const restaurant = await Restaurant.findOne({ _id: req.params.id, isActive: true, approvalStatus: 'approved' }).select('_id name rating ratingCount reviewCount');
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
  normalizeRestaurantImages(req.body);
  if (!req.body.cuisine && req.body.cuisineDisplay) req.body.cuisine = [req.body.cuisineDisplay]; 
  else if (!req.body.cuisine) req.body.cuisine = ['General'];
  if (!req.body.slug && req.body.name) req.body.slug = req.body.name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '') + '-' + Date.now();
  // Platform-wide policy: every newly created restaurant is online-payment only.
  // Ignore any legacy/forged codEnabled value supplied by the client.
  req.body.codEnabled = false;
  const restaurant = await Restaurant.create(req.body);
  res.status(201).json({ success: true, data: restaurant });
});

const updateRestaurant = asyncHandler(async (req, res) => {
  const existing = await Restaurant.findById(req.params.id);
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

  // Platform-wide policy: COD cannot be enabled by any caller.
  update.codEnabled = false;

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
  const restaurant = await Restaurant.findByIdAndUpdate(req.params.id, { $set: update }, { new: true, runValidators: true });
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
 * Body: { status: 'open' | 'closed_today' | 'temporarily_closed', opensAt?, closesAt?, autoHours? }
 *
 * PERMISSIONS: CEO can open/close any restaurant; vendor only their own.
 * opensAt/closesAt/autoHours are accepted and stored now (for the future
 * auto-hours feature) but are not evaluated yet — see Restaurant.js.
 */
const updateRestaurantAvailability = asyncHandler(async (req, res) => {
  const restaurant = await Restaurant.findById(req.params.id);
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });

  if (!canManageRestaurant(req.user, restaurant)) {
    return res.status(403).json({ success: false, message: 'Not authorized to manage this restaurant' });
  }

  const { status, opensAt, closesAt, autoHours } = req.body;
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

  // PERMISSIONS: CEO can add items to any restaurant; vendor only their own.
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

  // PERMISSIONS: CEO can edit any menu item; vendor only items on their own
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

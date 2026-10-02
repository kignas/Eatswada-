const MenuItem = require('../models/Menu');
const Restaurant = require('../models/Restaurant');
const asyncHandler = require('express-async-handler');


// GET /api/menu/pending — admin review queue for vendor-created menu items.
const getPendingMenuItems = asyncHandler(async (req, res) => {
  const filter = { approvalStatus: 'pending', isActive: { $ne: false } };
  if (req.query.restaurantId) filter.restaurantId = req.query.restaurantId;
  const items = await MenuItem.find(filter)
    .populate('restaurantId', 'name owner')
    .populate('createdBy', 'name email')
    .sort({ createdAt: 1 });
  res.json({ success: true, count: items.length, data: items });
});

const reviewMenuItem = asyncHandler(async (req, res) => {
  const action = req.params.action;
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ success:false, message:'Invalid review action.' });
  const item = await MenuItem.findById(req.params.itemId);
  if (!item) return res.status(404).json({ success:false, message:'Menu item not found.' });
  if (item.isActive === false) return res.status(409).json({success:false,message:'Inactive menu items cannot be approved.'});
  if (action === 'reject') {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({success:false,message:'A rejection reason is required.'});
    if (reason.length > 500) return res.status(400).json({success:false,message:'Rejection reason is too long.'});
    item.approvalStatus = 'rejected'; item.rejectionReason = reason;
  } else {
    item.approvalStatus = 'approved'; item.rejectionReason = '';
  }
  item.reviewedBy = req.user._id;
  item.reviewedAt = new Date();
  await item.save();
  res.json({success:true,message:action==='approve'?'Menu item approved and customer-visible.':'Menu item rejected.',data:item});
});

// GET /api/menu?restaurantId=... — admin view of one restaurant's full menu,
// including out-of-stock items (unlike the public getMenu, which filters inStock:true)
const getMenuItemsByRestaurant = asyncHandler(async (req, res) => {
  const { restaurantId } = req.query;
  if (!restaurantId) {
    return res.status(400).json({ success: false, message: 'restaurantId is required' });
  }

  const items = await MenuItem.find({ restaurantId }).sort({ category: 1, name: 1 });
  res.json({ success: true, count: items.length, data: items });
});

// POST /api/menu — admin creates a menu item and assigns it to a restaurant
const createMenuItem = asyncHandler(async (req, res) => {
  const { restaurantId } = req.body;
  if (!restaurantId) {
    return res.status(400).json({ success: false, message: 'restaurantId is required' });
  }

  const restaurant = await Restaurant.findById(restaurantId);
  if (!restaurant) {
    return res.status(404).json({ success: false, message: 'Restaurant not found' });
  }

  const payload = { ...req.body };
  if (!payload.image) delete payload.image; // let the schema default apply instead of saving ''

  payload.approvalStatus = 'approved';
  payload.isActive = true;
  payload.createdBy = req.user._id;
  const item = await MenuItem.create(payload);
  if (item.price <= 99) {
    item.isUnder99 = true;
    await item.save();
  }

  res.status(201).json({ success: true, data: item });
});

// PUT /api/menu/:itemId — admin edits any field, including reassigning the restaurant
const updateMenuItem = asyncHandler(async (req, res) => {
  if (req.body.restaurantId) {
    const restaurant = await Restaurant.findById(req.body.restaurantId);
    if (!restaurant) {
      return res.status(404).json({ success: false, message: 'Restaurant not found' });
    }
  }

  const item = await MenuItem.findByIdAndUpdate(req.params.itemId, req.body, {
    new: true,
    runValidators: true,
  });
  if (!item) return res.status(404).json({ success: false, message: 'Menu item not found' });

  if (req.body.price !== undefined) {
    item.isUnder99 = item.price <= 99;
    await item.save();
  }

  res.json({ success: true, data: item });
});

// DELETE /api/menu/:itemId
const deleteMenuItem = asyncHandler(async (req, res) => {
  const item = await MenuItem.findByIdAndUpdate(req.params.itemId, { $set: { isActive:false, inStock:false } }, { new:true });
  if (!item) return res.status(404).json({ success: false, message: 'Menu item not found' });
  res.json({ success: true, message: 'Menu item archived', data:item });
});

module.exports = {
  getMenuItemsByRestaurant,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  getPendingMenuItems,
  reviewMenuItem,
};

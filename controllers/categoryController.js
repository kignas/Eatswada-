'use strict';

const asyncHandler = require('express-async-handler');
const Category = require('../models/Category');
const { createMemoryCache, readTtlMs } = require('../utils/memoryCache');

// PERFORMANCE: GET /api/categories is identical for every customer, runs on
// every homepage load, and only changes when an admin edits categories. The
// result of the SAME query is kept in memory (default 60 s,
// CATEGORY_CACHE_TTL_MS=0 disables) and every admin write below clears it
// immediately, so admin changes still show up on the very next request.
const categoryCache = createMemoryCache({ ttlMs: readTtlMs('CATEGORY_CACHE_TTL_MS', 60000) });
const invalidateCategoryCache = () => categoryCache.invalidate();

// ==========================================
// 🌐 PUBLIC
// ==========================================

// @desc    Get active homepage categories, sorted for display
// @route   GET /api/categories
// @access  Public
const getCategories = asyncHandler(async (req, res) => {
  const categories = await categoryCache.get('active', () =>
    Category.find({ isActive: true }).sort({ order: 1, name: 1 })
  );
  res.json({ success: true, data: categories });
});

// ==========================================
// 🛡️ ADMIN (Manage Categories page)
// ==========================================

// @desc    Get every category, including hidden ones
// @route   GET /api/categories/all
// @access  Private (admin)
const getAllCategories = asyncHandler(async (req, res) => {
  const categories = await Category.find({}).sort({ order: 1, name: 1 });
  res.json({ success: true, data: categories });
});

// @desc    Create a new category
// @route   POST /api/categories
// @access  Private (admin)
const createCategory = asyncHandler(async (req, res) => {
  const { name, image, order } = req.body;

  let finalOrder = order;
  if (finalOrder === undefined || finalOrder === null) {
    // Append to the end — one above whatever the highest current order is.
    const last = await Category.findOne({}).sort({ order: -1 });
    finalOrder = last ? last.order + 1 : 0;
  }

  const payload = { name, order: finalOrder };
  if (image) payload.image = image; // omit '' so the schema default placeholder applies

  const category = await Category.create(payload);
  invalidateCategoryCache();
  res.status(201).json({ success: true, data: category });
});

// @desc    Update a category's name/image/order
// @route   PUT /api/categories/:id
// @access  Private (admin)
const updateCategory = asyncHandler(async (req, res) => {
  const { name, image, order } = req.body;
  const category = await Category.findByIdAndUpdate(
    req.params.id,
    { ...(name !== undefined && { name }), ...(image && { image }), ...(order !== undefined && { order }) },
    { new: true, runValidators: true }
  );
  invalidateCategoryCache();
  if (!category) return res.status(404).json({ success: false, message: 'Category not found' });
  res.json({ success: true, data: category });
});

// @desc    Show/hide a category on the homepage
// @route   PATCH /api/categories/:id/toggle
// @access  Private (admin)
const toggleCategoryStatus = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id);
  if (!category) return res.status(404).json({ success: false, message: 'Category not found' });
  category.isActive = !category.isActive;
  await category.save();
  invalidateCategoryCache();
  res.json({ success: true, data: { isActive: category.isActive } });
});

// @desc    Permanently delete a category
// @route   DELETE /api/categories/:id
// @access  Private (admin)
const deleteCategory = asyncHandler(async (req, res) => {
  const category = await Category.findByIdAndDelete(req.params.id);
  invalidateCategoryCache();
  if (!category) return res.status(404).json({ success: false, message: 'Category not found' });
  res.json({ success: true, message: 'Category deleted' });
});

// @desc    Save a new display order after drag-to-reorder
// @route   PUT /api/categories/reorder
// @access  Private (admin)
// @body    { items: [{ id, order }, ...] }
const reorderCategories = asyncHandler(async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'items must be a non-empty array of { id, order }' });
  }

  try {
    await Category.bulkWrite(
      items.map(({ id, order }) => ({
        updateOne: { filter: { _id: id }, update: { $set: { order } } },
      }))
    );
  } finally {
    // Also on failure: a bulkWrite can be partially applied before it throws.
    invalidateCategoryCache();
  }

  const categories = await Category.find({}).sort({ order: 1, name: 1 });
  res.json({ success: true, data: categories });
});

module.exports = {
  getCategories,
  getAllCategories,
  createCategory,
  updateCategory,
  toggleCategoryStatus,
  deleteCategory,
  reorderCategories,
};

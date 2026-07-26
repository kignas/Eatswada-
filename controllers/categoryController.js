'use strict';

const asyncHandler = require('express-async-handler');
const Category = require('../models/Category');

// ==========================================
// 🌐 PUBLIC
// ==========================================

// @desc    Get active homepage categories, sorted for display
// @route   GET /api/categories
// @access  Public
const getCategories = asyncHandler(async (req, res) => {
  const categories = await Category.find({ isActive: true }).sort({ order: 1, name: 1 });
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

  const category = await Category.create({ name, image, order: finalOrder });
  res.status(201).json({ success: true, data: category });
});

// @desc    Update a category's name/image/order
// @route   PUT /api/categories/:id
// @access  Private (admin)
const updateCategory = asyncHandler(async (req, res) => {
  const { name, image, order } = req.body;
  const category = await Category.findByIdAndUpdate(
    req.params.id,
    { ...(name !== undefined && { name }), ...(image !== undefined && { image }), ...(order !== undefined && { order }) },
    { new: true, runValidators: true }
  );
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
  res.json({ success: true, data: { isActive: category.isActive } });
});

// @desc    Permanently delete a category
// @route   DELETE /api/categories/:id
// @access  Private (admin)
const deleteCategory = asyncHandler(async (req, res) => {
  const category = await Category.findByIdAndDelete(req.params.id);
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

  await Category.bulkWrite(
    items.map(({ id, order }) => ({
      updateOne: { filter: { _id: id }, update: { $set: { order } } },
    }))
  );

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

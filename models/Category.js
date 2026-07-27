'use strict';

const mongoose = require('mongoose');

/**
 * Category Schema
 *
 * Represents a homepage "What's on your mind?" category tile
 * (e.g. Biryani, Pizza, Rolls) — previously hardcoded on the frontend.
 *
 * Architectural rules enforced:
 *  - name is unique — it doubles as the filter value passed to
 *    GET /api/restaurants?category=<name>, so duplicates would silently
 *    merge two tiles' results.
 *  - order drives display sequence (drag-to-reorder writes this field).
 *  - isActive is the soft-delete flag, consistent with Restaurant. A
 *    category is hidden by setting isActive: false, never hard-deleted.
 */
const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Category name is required'],
      trim: true,
      unique: true,
      maxlength: [50, 'Category name cannot exceed 50 characters'],
    },

    image: {
      type: String,
      default: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836',
    },

    // Display sequence on the homepage. Lower numbers show first.
    order: {
      type: Number,
      default: 0,
      index: true,
    },

    // Soft-delete / show-hide flag. NEVER hard-delete a category.
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt automatically.
  }
);

module.exports = mongoose.model('Category', categorySchema);

const mongoose = require('mongoose');

const menuItemSchema = new mongoose.Schema(
  {
    // 🚨 UPDATED: Changed to 'restaurantId' to match the Vendor security locks
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Item name is required'],
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 400,
      default: '',
    },
    price: {
      type: Number,
      required: [true, 'Price is required'],
      min: [0, 'Price cannot be negative'],
    },
    originalPrice: {
      type: Number,  // for strikethrough display
    },
    // 🚨 PERFECT: You already had the image field. I just added a premium default fallback!
    image: {
      type: String,
      default: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c',
    },
    isVeg: {
      type: Boolean,
      default: true,
    },
    category: {
      type: String,
      trim: true,
      default: 'Main Course',
    },
    // Matches "under99.html" — items priced ≤₹99
    isUnder99: {
      type: Boolean,
      default: false,
    },
    isBestseller: {
      type: Boolean,
      default: false,
    },
    isRecommended: {
      type: Boolean,
      default: false,
    },
    // 🚨 UPDATED: Changed from 'isAvailable' to 'inStock' so the Vendor Toggle works!
    inStock: {
      type: Boolean,
      default: true,
    },
    customizations: [
      {
        title: String,
        options: [
          {
            label: String,
            extraPrice: { type: Number, default: 0 },
          },
        ],
      },
    ],
    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

// 🚨 UPDATED: Fixed the index to match the new 'restaurantId' field
menuItemSchema.index({ restaurantId: 1, category: 1 });
menuItemSchema.index({ name: 'text', description: 'text' });

// Exported as 'Menu' to match your controller imports
module.exports = mongoose.model('Menu', menuItemSchema);

// --- DATABASE INDEXES FOR PERFORMANCE ---
menuItemSchema.index({ restaurantId: 1, inStock: 1 }); // Corrected schema and field names!

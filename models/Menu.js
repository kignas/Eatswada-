const mongoose = require('mongoose');

const menuItemSchema = new mongoose.Schema(
  {
    restaurant: {
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
    image: {
      type: String,
      default: '',
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
    isAvailable: {
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

menuItemSchema.index({ restaurant: 1, category: 1 });
menuItemSchema.index({ name: 'text', description: 'text' });

module.exports = mongoose.model('MenuItem', menuItemSchema);

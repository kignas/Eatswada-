const mongoose = require('mongoose');

const restaurantSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Restaurant name is required'],
      trim: true,
      maxlength: 100,
      index: true,
    },
    slug: {
     type: String,
     required: true,
     unique: true,
     lowercase: true,
     trim: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    image: {
      type: String,
      default: '',
    },
    cuisine: {
      type: [String],
      required: true,
    },
    // Matches frontend: "Biryani, Chinese, North Indian"
    cuisineDisplay: {
      type: String,
      default: '',
    },
    rating: {
      type: Number,
      default: 4.0,
      min: 1,
      max: 5,
    },
    ratingCount: {
      type: String,
      default: '100+',
    },
    time: {
      type: String,   // e.g. "25-35 mins"
      default: '30-40 mins',
    },
    distance: {
      type: String,   // e.g. "1.2 km"
      default: '2 km',
    },
    offer: {
      type: String,   // e.g. "20% OFF up to ₹50"
      default: '',
    },
    minOrder: {
      type: Number,
      default: 0,
    },
    deliveryFee: {
      type: Number,
      default: 40,
    },
    freeDeliveryAbove: {
      type: Number,
      default: 200,
    },
    platformFee: {
      type: Number,
      default: 5,
    },
    isVeg: {
      type: Boolean,
      default: false,
    },
    isOpen: {
      type: Boolean,
      default: true,
    },
    isFeatured: {
      type: Boolean,
      default: false,
    },
    address: {
      type: String,
      trim: true,
    },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        default: [88.3832, 26.4416], // Maynaguri default
      },
    },
    // Category tags matching frontend category.html
    categories: {
      type: [String],
      index: true,
    },
    totalOrders: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

restaurantSchema.index({ location: '2dsphere' });
restaurantSchema.index({ name: 'text', cuisineDisplay: 'text' });

// Auto-generate slug
restaurantSchema.pre('save', function (next) {
  if (this.isModified('name') && !this.slug) {
    this.slug = this.name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '');
  }
  next();
});

module.exports = mongoose.model('Restaurant', restaurantSchema);

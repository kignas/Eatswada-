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
    // Retained for frontend backward compatibility
    time: {
      type: String,
      default: '30-40 mins',
    },
    distance: {
      type: String,
      default: '2 km',
    },
    // Production numeric fields for accurate database sorting
    estimatedDeliveryMin: {
      type: Number,
      default: 30,
    },
    estimatedDeliveryMax: {
      type: Number,
      default: 40,
    },
    distanceMeters: {
      type: Number,
      default: 2000,
    },
    offer: {
      type: String,
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
    isActive: {
      type: Boolean,
      default: true,
      index: true, // Speeds up filtering for active restaurants
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

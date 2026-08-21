'use strict';

const mongoose = require('mongoose');

/**
 * Restaurant Schema
 *
 * Architectural rules enforced:
 *  - All sortable/comparable fields (times, distances, fees) are stored as Number.
 *  - String display fields (time, distance) are auto-derived from their Number
 *    counterparts in a pre-save hook — no manual synchronisation required.
 *  - ratingCount is now a Number (was String "100+" which violated Rule #4).
 *  - owner is required — a restaurant without an owner breaks vendor queries.
 *  - isActive is the soft-delete flag. Hard deletes are banned.
 *  - availability.isOpen is the source of truth for open/closed; the legacy
 *    top-level isOpen mirrors it (kept for existing queries elsewhere).
 */
const restaurantSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Restaurant name is required'],
      trim: true,
      maxlength: [100, 'Restaurant name cannot exceed 100 characters'],
      index: true,
    },

    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    // The User (_id) who owns this restaurant — required for vendor portal auth.
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A restaurant must have an owner'],
      index: true,
    },

    image: {
      type: String,
      default: '',
    },

    // Up to 4 customer-facing restaurant photos. `image` remains the
    // backward-compatible primary/cover image and is kept in sync with images[0].
    images: {
      type: [String],
      default: [],
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length <= 4,
        message: 'A restaurant can have at most 4 images.',
      },
    },

    cuisine: {
      type: [String],
      required: [true, 'At least one cuisine type is required'],
    },

    // Flat, comma-joined string for full-text search and display.
    // Kept in sync by the pre-save hook below.
    cuisineDisplay: {
      type: String,
      default: '',
    },

    rating: {
      type: Number,
      default: 4.0,
      min: [1, 'Rating cannot be below 1'],
      max: [5, 'Rating cannot exceed 5'],
    },

    // ── RULE #4: ratingCount is a Number, not a String "100+" ──
    ratingCount: {
      type: Number,
      default: 100,
      min: 0,
    },

    // ── Numeric source-of-truth fields (used for DB sorting and filtering) ──
    estimatedDeliveryMin: {
      type: Number,
      default: 30,
      min: 0,
    },
    estimatedDeliveryMax: {
      type: Number,
      default: 40,
      min: 0,
    },
    distanceMeters: {
      type: Number,
      default: 2000,
      min: 0,
    },

    // ── Display-only string fields (auto-derived in pre-save hook) ──
    // Kept for frontend backward compatibility. Do NOT set these manually.
    time: {
      type: String,
      default: '30-40 mins',
    },
    distance: {
      type: String,
      default: '2 km',
    },

    offer: {
      type: String,
      default: '',
      trim: true,
    },

    minOrder: {
      type: Number,
      default: 0,
      min: 0,
    },

    deliveryFee: {
      type: Number,
      default: 40,
      min: 0,
    },

    freeDeliveryAbove: {
      type: Number,
      default: 200,
      min: 0,
    },

    freeDeliveryEnabled: {
      type: Boolean,
      default: true,
    },

    // Maximum customer-to-restaurant delivery radius controlled by Admin.
    // Actual order distance is calculated from customer + restaurant GPS.
    deliveryRadiusKm: {
      type: Number,
      default: 15,
      min: 0,
      max: 100,
    },

    isVeg: {
      type: Boolean,
      default: false,
    },

    // isOpen: real-time open/close (e.g. outside operating hours).
    // ⚠️ LEGACY / DERIVED — kept only for backward compatibility with existing
    // queries (getRestaurantById, getCategories, searchRestaurants, sort, etc.).
    // Source of truth going forward is `availability.isOpen` below; this field
    // is mirrored from it in the pre-validate hook, and must be set manually
    // alongside `availability.isOpen` in any controller code that uses
    // findByIdAndUpdate (which skips document middleware) — see restaurantController.js.
    isOpen: {
      type: Boolean,
      default: true,
    },

    // ── Restaurant Availability ──
    // Scalable structure: supports Open / Closed Today / Temporarily Closed now,
    // and leaves room for automatic business-hours support later (autoHours/
    // opensAt/closesAt are stored today but not yet evaluated anywhere).
    availability: {
      // Manual real-time toggle. This is the source of truth for open/closed.
      isOpen: {
        type: Boolean,
        default: true,
      },
      // Future feature flag: when true, isOpen will eventually be computed
      // from opensAt/closesAt instead of being toggled manually. Not evaluated yet.
      autoHours: {
        type: Boolean,
        default: false,
      },
      // "HH:MM" 24-hour format, e.g. "09:00". Reserved for future auto-hours use.
      opensAt: {
        type: String,
        default: '',
        trim: true,
      },
      closesAt: {
        type: String,
        default: '',
        trim: true,
      },
      // Populated only when isOpen is false, to distinguish *why*.
      closedReason: {
        type: String,
        enum: ['', 'closed_today', 'temporarily_closed'],
        default: '',
      },
    },

    // isActive: soft-delete flag. NEVER hard-delete a restaurant.
    // Set to false to deactivate without destroying order history.
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    isFeatured: {
      type: Boolean,
      default: false,
    },

    address: {
      type: String,
      trim: true,
      default: '',
    },

    // GeoJSON Point for location-based queries.
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        default: [88.3832, 22.5726], // Kolkata default; override on creation.
      },
    },

    // Top-level category tags for homepage filter chips (e.g. "Biryani", "Pizza").
    categories: {
      type: [String],
      index: true,
      default: [],
    },

    totalOrders: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt automatically.
  }
);

// ── Geospatial index for $near queries ──
restaurantSchema.index({ location: '2dsphere' });

// ── Full-text search index for /search endpoint ──
restaurantSchema.index({ name: 'text', cuisineDisplay: 'text' });

/**
 * pre('save') hook
 *
 * Responsibilities:
 *  1. Auto-generate slug from name (only on creation, not on update).
 *  2. Keep cuisineDisplay in sync with the cuisine array.
 *  3. Derive the string display fields (time, distance) from their
 *     numeric counterparts so the frontend never sees stale display strings.
 */
restaurantSchema.pre('validate', function (next) {
  // 1. Slug generation — only runs if name changed AND no slug exists yet.
  if (this.isModified('name') && !this.slug) {
    this.slug = this.name
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^\w-]/g, '');
  }

  // 2. Keep cuisineDisplay in sync with the cuisine array.
  if (this.isModified('cuisine') && Array.isArray(this.cuisine)) {
    this.cuisineDisplay = this.cuisine.join(', ');
  }

  // Keep the legacy primary image synchronized with the first gallery image.
  if (this.isModified('images')) {
    this.images = (Array.isArray(this.images) ? this.images : [])
      .filter(Boolean)
      .slice(0, 4);
    this.image = this.images[0] || this.image || '';
  } else if (this.isModified('image') && this.image && (!Array.isArray(this.images) || !this.images.length)) {
    this.images = [this.image];
  }

  // 3. Derive human-readable display strings from numeric fields.
  if (this.isModified('estimatedDeliveryMin') || this.isModified('estimatedDeliveryMax')) {
    this.time = `${this.estimatedDeliveryMin}-${this.estimatedDeliveryMax} mins`;
  }

  if (this.isModified('distanceMeters')) {
    const km = (this.distanceMeters / 1000).toFixed(1);
    this.distance = `${km} km`;
  }

  // 4. Mirror the new availability.isOpen into the legacy top-level isOpen
  //    field, so existing filters/queries elsewhere in the app that still
  //    read the top-level field keep working unchanged.
  //    NOTE: this only fires on .save()/.create() (document middleware).
  //    Controllers using findByIdAndUpdate must set both fields explicitly.
  if (this.isModified('availability.isOpen') || this.isModified('availability')) {
    this.isOpen = this.availability.isOpen;
  }

  next();
});


module.exports = mongoose.model('Restaurant', restaurantSchema);

// --- DATABASE INDEXES FOR PERFORMANCE ---


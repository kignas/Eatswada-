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
        required: { type: Boolean, default: false },
        minSelect: { type: Number, default: 0 },   // 0 = optional
        maxSelect: { type: Number, default: 1 },   // 1 = single-select; N = "select up to N"
        options: [
          {
            label: String,
            extraPrice: { type: Number, default: 0 },
            isVeg: { type: Boolean, default: true },
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

// --- DATABASE INDEXES FOR PERFORMANCE ---
// These two declarations used to sit AFTER mongoose.model() below. Index
// declarations must be registered on the schema before the model is compiled
// to be reliably part of the model's index set, so they now live here. Same
// indexes, same keys, no new ones.
menuItemSchema.index({ restaurantId: 1, inStock: 1 }); // Corrected schema and field names!
// Phase 2 (Performance at Scale): backs getUnder99Items (the ₹99 store / deals
// browse), which filters price + inStock ACROSS all restaurants and sorts by
// price. inStock leads (equality) so Mongo seeks straight to in-stock items,
// then walks price in order — replacing a full-collection scan + in-memory sort.
menuItemSchema.index({ inStock: 1, price: 1 });

// --- MENU WRITE COUNTER (performance: public menu response cache) ---
// GET /api/restaurants/:id/menu keeps a short in-memory cache
// (restaurantController). To keep it exact, every successful menu write made
// through this model — create/save, update, in-stock toggle, delete,
// insertMany — increments this counter AFTER MongoDB acknowledges it, and the
// cache drops everything whenever the counter has moved. Nothing here changes
// what a write does; the hooks only increment a number.
let menuWriteVersion = 0;
function markMenuWrite() { menuWriteVersion += 1; }

menuItemSchema.post('save', markMenuWrite);
for (const op of ['updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'replaceOne', 'deleteMany']) {
  menuItemSchema.post(op, markMenuWrite);
}
// updateOne / deleteOne exist as both query and document middleware.
menuItemSchema.post('updateOne', { document: true, query: true }, markMenuWrite);
menuItemSchema.post('deleteOne', { document: true, query: true }, markMenuWrite);
menuItemSchema.post('insertMany', markMenuWrite);
menuItemSchema.post('bulkWrite', markMenuWrite);

menuItemSchema.statics.menuWriteVersion = function menuWriteVersionStatic() { return menuWriteVersion; };
// For writes whose visibility is delayed (a transaction commits later).
menuItemSchema.statics.markMenuWrite = function markMenuWriteStatic() { markMenuWrite(); };

// Exported as 'Menu' to match your controller imports
module.exports = mongoose.model('Menu', menuItemSchema);

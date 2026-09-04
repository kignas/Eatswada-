const mongoose = require('mongoose');

const cartItemSchema = new mongoose.Schema(
  {
    menuItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Menu',
      required: true,
    },
    // AUTHORITATIVE per-item restaurant ownership (multi-restaurant carts).
    // This is resolved server-side from the Menu document at add-to-cart
    // time (see cartController.addToCart) — never from a client-supplied
    // restaurantId. It is what lets one cart hold items from several
    // restaurants while each item still carries a trustworthy owner.
    // Legacy carts created before this field existed are back-filled from
    // the Menu document on the next read (see cartController.buildCartResponse).
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
      index: true,
    },
    restaurantName: { type: String, default: '' }, // snapshot for display only
    name: { type: String, required: true },  // snapshot to avoid join
    price: { type: Number, required: true }, // selling price snapshot
    originalPrice: { type: Number, default: null, min: 0 }, // MRP/original price snapshot
    image: { type: String, default: '' },
    isVeg: { type: Boolean, default: true },
    quantity: {
      type: Number,
      required: true,
      min: [1, 'Quantity must be at least 1'],
    },
    customizations: { type: Object, default: {} },
  },
  { _id: true }
);

const cartSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,   // one cart per user
      index: true,
    },
    // LEGACY top-level restaurant fields. Kept for backward compatibility
    // with older frontend/API builds that read cart.restaurant /
    // cart.restaurantName directly. Authoritative ownership now lives on
    // each item (cartItemSchema.restaurant). For a multi-restaurant cart
    // these mirror the FIRST group only and must not be treated as the
    // single owner of the cart. Do NOT remove in this phase.
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      default: null,
    },
    restaurantName: {
      type: String,
      default: '',
    },
    items: [cartItemSchema],

    // LEGACY denormalized totals. `subtotal` stays correct (sum of items).
    // `deliveryFee`/`total` are no longer a single global figure — delivery
    // is now priced per restaurant group and returned live by
    // cartController.buildCartResponse (and re-verified at checkout). These
    // stored fields are kept only so old readers of the raw document don't
    // break; the API response is the authoritative source.
    subtotal:    { type: Number, default: 0 },
    deliveryFee: { type: Number, default: 0 },
    total:       { type: Number, default: 0 },

    // Delivery address snapshot for checkout
    deliveryAddress: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Address',
      default: null,
    },
    paymentMethod: {
      type: String,
      enum: ['cod'],
      default: 'cod',
    },
  },
  { timestamps: true }
);

/* ── Virtual: total item count ── */
cartSchema.virtual('itemCount').get(function () {
  return this.items.reduce((sum, i) => sum + i.quantity, 0);
});

/* ── Pre-save: recalculate the denormalized food subtotal ──
 * Delivery is NO LONGER a single global fee computed here. The old
 * hardcoded FREE_DELIVERY_ABOVE/DELIVERY_FEE have been removed: delivery
 * is priced per restaurant group in cartController.buildCartResponse using
 * each Restaurant's own fields, and re-verified authoritatively at checkout
 * in orderController. We keep only the food subtotal (always the sum of
 * item lines) and mirror it into `total`; the stored `deliveryFee` is left
 * at 0 because a single global delivery figure is no longer meaningful. */
cartSchema.pre('save', function (next) {
  const subtotal = this.items.reduce((s, i) => s + i.quantity * i.price, 0);
  this.subtotal    = Math.round(subtotal * 100) / 100;
  this.deliveryFee = 0;
  this.total       = this.subtotal;
  next();
});

module.exports = mongoose.model('Cart', cartSchema);

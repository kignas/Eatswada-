const mongoose = require('mongoose');

const cartItemSchema = new mongoose.Schema(
  {
    menuItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Menu',
      required: true,
    },
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

    // Computed totals (updated on every write)
    subtotal:    { type: Number, default: 0 },
    deliveryFee: { type: Number, default: 40 },
    total:       { type: Number, default: 0 },

    // Delivery address snapshot for checkout
    deliveryAddress: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Address',
      default: null,
    },
    paymentMethod: {
      type: String,
      enum: ['upi', 'card', 'cod', 'wallet'],
      default: 'upi',
    },
  },
  { timestamps: true }
);

/* ── Virtual: total item count ── */
cartSchema.virtual('itemCount').get(function () {
  return this.items.reduce((sum, i) => sum + i.quantity, 0);
});

/* ── Pre-save: recalculate totals ── */
cartSchema.pre('save', function (next) {
  const subtotal = this.items.reduce((s, i) => s + i.quantity * i.price, 0);
  const FREE_DELIVERY_ABOVE = 200;
  const DELIVERY_FEE = 40;

  this.subtotal    = subtotal;
  this.deliveryFee = subtotal >= FREE_DELIVERY_ABOVE ? 0 : DELIVERY_FEE;
  this.total       = subtotal + this.deliveryFee;
  next();
});

module.exports = mongoose.model('Cart', cartSchema);

const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  menuItem:  { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' },
  name:      { type: String, required: true },
  price:     { type: Number, required: true },
  image:     { type: String, default: '' },
  isVeg:     { type: Boolean, default: true },
  quantity:  { type: Number, required: true, min: 1 },
  customizations: { type: Object, default: {} },
}, { _id: false });

const statusEventSchema = new mongoose.Schema({
  status:    { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  note:      { type: String, default: '' },
}, { _id: false });

const orderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      unique: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
    },
    restaurantName: { type: String, required: true },
    restaurantImage: { type: String, default: '' },

    items: [orderItemSchema],

    // Address snapshot (do NOT ref — address can be deleted later)
    deliveryAddress: {
      tag:      String,
      house:    String,
      area:     String,
      landmark: String,
      city:     String,
      pincode:  String,
    },

    // Pricing (matches cart.html bill summary)
    subtotal:    { type: Number, required: true },
    deliveryFee: { type: Number, default: 40 },
    platformFee: { type: Number, default: 5 },
    discount:    { type: Number, default: 0 },
    total:       { type: Number, required: true },

    paymentMethod: {
      type: String,
      enum: ['upi', 'card', 'cod', 'wallet'],
      default: 'upi',
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    razorpayOrderId:   { type: String, default: '' },
    razorpayPaymentId: { type: String, default: '' },

    // ORDER LIFECYCLE — mirrors track-order.html progress bar
    status: {
      type: String,
      enum: [
        'placed',       // order placed, awaiting restaurant confirm
        'confirmed',    // restaurant accepted
        'preparing',    // kitchen is cooking
        'out_for_delivery', // on the way
        'delivered',    // completed
        'cancelled',    // cancelled by user / restaurant
      ],
      default: 'placed',
      index: true,
    },
    statusHistory: [statusEventSchema],

    estimatedDelivery: { type: Date },
    deliveredAt:       { type: Date },
    cancelReason:      { type: String, default: '' },
    isCancellable: {
      type: Boolean,
      default: true,   // becomes false once 'preparing' or beyond
    },
    rating: {
      score:   { type: Number, min: 1, max: 5 },
      comment: { type: String, maxlength: 400 },
      givenAt: Date,
    },
  },
  { timestamps: true }
);

/* ── Pre-save: generate order number ── */
orderSchema.pre('save', function (next) {
  if (this.isNew) {
    const ts   = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).substr(2, 4).toUpperCase();
    this.orderNumber = `NB-${ts}-${rand}`;

    // Push initial status event
    this.statusHistory.push({ status: 'placed', note: 'Order placed by customer' });

    // Estimated delivery: 40 mins from now
    this.estimatedDelivery = new Date(Date.now() + 40 * 60 * 1000);
  }
  next();
});

/* ── Instance method: advance status ── */
orderSchema.methods.advanceStatus = function (newStatus, note = '') {
  const NON_CANCELLABLE = ['preparing', 'out_for_delivery', 'delivered'];
  this.status = newStatus;
  this.statusHistory.push({ status: newStatus, note });
  if (NON_CANCELLABLE.includes(newStatus)) this.isCancellable = false;
  if (newStatus === 'delivered') this.deliveredAt = new Date();
  return this;
};

module.exports = mongoose.model('Order', orderSchema);

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

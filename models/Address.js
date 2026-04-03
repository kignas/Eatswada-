const mongoose = require('mongoose');

const addressSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    tag: {
      type: String,
      enum: ['Home', 'Work', 'Other'],
      default: 'Home',
    },
    house: {
      type: String,
      required: [true, 'House / Flat number is required'],
      trim: true,
      maxlength: 100,
    },
    area: {
      type: String,
      required: [true, 'Area / Street is required'],
      trim: true,
      maxlength: 200,
    },
    landmark: {
      type: String,
      trim: true,
      maxlength: 200,
      default: '',
    },
    city: {
      type: String,
      trim: true,
      default: 'Maynaguri',
    },
    pincode: {
      type: String,
      trim: true,
      match: [/^\d{6}$/, 'Pincode must be 6 digits'],
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
    // GeoJSON point for future distance-based queries
    location: {
      type: {
        type: String,
        enum: ['Point'],
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
      },
    },
  },
  { timestamps: true }
);

addressSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('Address', addressSchema);

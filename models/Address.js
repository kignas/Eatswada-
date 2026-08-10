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
    // Google Maps / device-selected location.
    // GeoJSON coordinates are always [longitude, latitude].
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        validate: {
          validator: function (value) {
            if (!Array.isArray(value) || value.length !== 2) return false;
            const [lng, lat] = value.map(Number);
            return Number.isFinite(lng) && Number.isFinite(lat) &&
              lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90;
          },
          message: 'Location must contain [longitude, latitude].',
        },
      },
    },
  },
  { timestamps: true }
);

addressSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('Address', addressSchema);

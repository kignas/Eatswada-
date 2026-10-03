'use strict';

const mongoose = require('mongoose');

/**
 * VendorApplication
 *
 * A pending marketplace onboarding record. The applicant's password is kept
 * on the linked, inactive vendor User document (never in this application),
 * so a rejected/pending applicant can re-apply without creating duplicate
 * staff credentials.
 */
const vendorApplicationSchema = new mongoose.Schema({
  applicant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true,
  },
  restaurantName: {
    type: String,
    required: [true, 'Restaurant name is required'],
    trim: true,
    maxlength: [100, 'Restaurant name cannot exceed 100 characters'],
  },
  ownerName: {
    type: String,
    required: [true, 'Owner name is required'],
    trim: true,
    maxlength: [60, 'Owner name cannot exceed 60 characters'],
  },
  email: { type: String, required: true, lowercase: true, trim: true },
  phone: { type: String, required: true, trim: true },
  cuisine: {
    type: [String],
    required: true,
    validate: {
      validator: (v) => Array.isArray(v) && v.length > 0 && v.length <= 10,
      message: 'At least one cuisine is required.',
    },
  },
  description: { type: String, trim: true, maxlength: 1000, default: '' },
  businessType: { type: String, enum: ['restaurant', 'cloud_kitchen'], default: 'restaurant' },
  deliveryMode: { type: String, enum: ['self_delivery', 'eatswada_rider'], default: 'eatswada_rider' },
  requestedCommissionRate: { type: Number, min: 0, max: 100, default: 25 },
  maxActiveOrders: { type: Number, min: 1, max: 500, default: 20 },
  settlementSchedule: { type: String, enum: ['weekly', 'monthly'], default: 'weekly' },
  address: { type: String, trim: true, maxlength: 500, default: '' },
  fssaiLicenseNumber: { type: String, required: [true, 'FSSAI license / registration number is required'], trim: true, maxlength: 100 },
  fssaiCertificateUrl: { type: String, trim: true, maxlength: 2000, default: '' },
  fssaiExpiryDate: { type: Date, default: null },
  deliveryFee: { type: Number, min: 0, max: 100000, default: 40 },
  minOrder: { type: Number, min: 0, max: 100000, default: 0 },
  freeDeliveryEnabled: { type: Boolean, default: true },
  freeDeliveryAbove: { type: Number, min: 0, max: 100000, default: 200 },
  openingHours: {
    monday: { closed: { type: Boolean, default: false }, opensAt: { type: String, default: '10:00' }, closesAt: { type: String, default: '22:00' } },
    tuesday: { closed: { type: Boolean, default: false }, opensAt: { type: String, default: '10:00' }, closesAt: { type: String, default: '22:00' } },
    wednesday: { closed: { type: Boolean, default: false }, opensAt: { type: String, default: '10:00' }, closesAt: { type: String, default: '22:00' } },
    thursday: { closed: { type: Boolean, default: false }, opensAt: { type: String, default: '10:00' }, closesAt: { type: String, default: '22:00' } },
    friday: { closed: { type: Boolean, default: false }, opensAt: { type: String, default: '10:00' }, closesAt: { type: String, default: '22:00' } },
    saturday: { closed: { type: Boolean, default: false }, opensAt: { type: String, default: '10:00' }, closesAt: { type: String, default: '22:00' } },
    sunday: { closed: { type: Boolean, default: false }, opensAt: { type: String, default: '10:00' }, closesAt: { type: String, default: '22:00' } },
  },
  image: { type: String, trim: true, maxlength: 2000, default: '' },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: {
      type: [Number],
      validate: {
        validator: (v) => !v || (Array.isArray(v) && v.length === 2 &&
          Number.isFinite(v[0]) && Number.isFinite(v[1]) &&
          v[0] >= -180 && v[0] <= 180 && v[1] >= -90 && v[1] <= 90),
        message: 'Location coordinates must be [longitude, latitude].',
      },
    },
  },
  status: {
    type: String,
    enum: ['pending', 'needs_changes', 'approved', 'rejected'],
    default: 'pending',
    index: true,
  },
  rejectionReason: { type: String, trim: true, maxlength: 1000, default: '' },
  changeRequest: { type: String, trim: true, maxlength: 1000, default: '' },
  adminNotes: { type: String, trim: true, maxlength: 2000, default: '' },
  vendorAgreementVersion: { type: String, trim: true, maxlength: 100, default: '' },
  vendorAgreementAcceptedAt: { type: Date, default: null },
  privacyPolicyVersion: { type: String, trim: true, maxlength: 100, default: '' },
  privacyPolicyAcceptedAt: { type: Date, default: null },
  restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', default: null },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },
  // Legacy public-status token fields remain optional for old applications.
  // New customer-owned applications use authenticated ownership instead.
  statusTokenHash: { type: String, required: false, select: false },
  statusTokenExpiresAt: { type: Date, required: false, select: false },
}, { timestamps: true });

vendorApplicationSchema.index({ status: 1, createdAt: -1 });
vendorApplicationSchema.index({ email: 1 });
vendorApplicationSchema.index({ phone: 1 });

module.exports = mongoose.model('VendorApplication', vendorApplicationSchema);

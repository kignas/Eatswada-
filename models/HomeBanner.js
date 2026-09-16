'use strict';

const mongoose = require('mongoose');

const urlValidator = {
  validator: (value) => {
    if (!value) return true;
    const v = String(value).trim();
    return (v.startsWith('/') && !v.startsWith('//')) || /^https:\/\//i.test(v);
  },
  message: 'CTA URL must be a relative path or an HTTPS URL.'
};

const homeBannerSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 90 },
  subtitle: { type: String, trim: true, maxlength: 140, default: '' },
  offerText: { type: String, trim: true, maxlength: 60, default: '' },
  badgeText: { type: String, trim: true, maxlength: 40, default: '' },
  ctaText: { type: String, trim: true, maxlength: 30, default: 'Order now' },
  ctaUrl: { type: String, trim: true, maxlength: 300, default: '', validate: urlValidator },
  image: { type: String, required: true, trim: true, maxlength: 1000 },
  mobileImage: { type: String, trim: true, maxlength: 1000, default: '' },
  background: { type: String, trim: true, maxlength: 120, default: '#0B6B46' },
  textColor: { type: String, enum: ['light', 'dark'], default: 'light' },
  animation: { type: String, enum: ['fade', 'slide', 'scale', 'none'], default: 'fade' },
  headerTheme: { type: String, enum: ['anime', 'pink', 'lavender', 'magenta'], default: 'anime', index: true },
  active: { type: Boolean, default: true, index: true },
  priority: { type: Number, min: 0, max: 9999, default: 0, index: true },
  startAt: { type: Date, default: null, index: true },
  endAt: { type: Date, default: null, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

homeBannerSchema.index({ active: 1, priority: -1, createdAt: -1 });

module.exports = mongoose.models.HomeBanner || mongoose.model('HomeBanner', homeBannerSchema);

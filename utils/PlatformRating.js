'use strict';

const mongoose = require('mongoose');

const platformRatingSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  sequence: {
    type: Number,
    required: true,
    min: 1,
    max: 3,
  },
  score: {
    type: Number,
    required: true,
    min: 1,
    max: 5,
    validate: { validator: Number.isInteger, message: 'Rating must be a whole number from 1 to 5.' },
  },
  comment: {
    type: String,
    trim: true,
    maxlength: 500,
    default: '',
  },
}, { timestamps: true });

platformRatingSchema.index({ createdAt: -1 });
platformRatingSchema.index({ user: 1, sequence: 1 }, { unique: true });
platformRatingSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('PlatformRating', platformRatingSchema);

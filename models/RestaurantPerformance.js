'use strict';

const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────────────
// Restaurant performance snapshot (ranking engine).
//
// One row per restaurant, holding the LATEST computed performance score and
// every factor that produced it, plus the rolling window the factors came
// from. This is a materialised, periodically-refreshed read model: the
// customer listing sorts on `score` from here instead of running seven
// aggregation pipelines per request.
//
// `factors` stores each normalised 0–1 component AND the raw value behind it,
// so the admin console can show "why" a restaurant ranks where it does
// (requirement: "View ranking factors") without recomputing anything.
//
// `dataConfidence` is the share of the scoring weights that actually had
// enough sample data. New restaurants score with a neutral prior and a low
// confidence, so they are neither promoted nor buried (requirement: "Do not
// unfairly penalize new restaurants with insufficient data").
// ─────────────────────────────────────────────────────────────────────

const factorSchema = new mongoose.Schema({
  key: { type: String, required: true },
  label: { type: String, default: '' },
  weight: { type: Number, default: 0 },      // configured weight (0–1)
  normalised: { type: Number, default: 0 },  // 0–1 after normalisation
  raw: { type: mongoose.Schema.Types.Mixed, default: null },
  hasData: { type: Boolean, default: false },
}, { _id: false });

const restaurantPerformanceSchema = new mongoose.Schema({
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, unique: true, index: true },

  // 0–100 weighted performance score (see services/restaurantPerformanceService).
  score: { type: Number, default: 0, min: 0, max: 100, index: true },
  // Share of weights backed by enough data (0–1). Low = new/thin history.
  dataConfidence: { type: Number, default: 0, min: 0, max: 1 },
  isNewRestaurant: { type: Boolean, default: true },

  factors: { type: [factorSchema], default: [] },

  // Raw sample counts for the rolling window, kept for transparency/audit.
  sample: {
    orders: { type: Number, default: 0 },
    completed: { type: Number, default: 0 },
    cancelled: { type: Number, default: 0 },
    reviews: { type: Number, default: 0 },
    complaints: { type: Number, default: 0 },
    refunds: { type: Number, default: 0 },
    repeatOrders: { type: Number, default: 0 },
    avgRating: { type: Number, default: null },
    avgPrepMinutes: { type: Number, default: null },
    lateOrders: { type: Number, default: 0 },
  },

  windowDays: { type: Number, default: 30 },
  weights: { type: mongoose.Schema.Types.Mixed, default: {} },
  computedAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true });

// Ranking read: online-first ordering sorts by score inside the online group.
restaurantPerformanceSchema.index({ score: -1, computedAt: -1 });

module.exports = mongoose.models.RestaurantPerformance || mongoose.model('RestaurantPerformance', restaurantPerformanceSchema);

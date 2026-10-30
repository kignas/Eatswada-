'use strict';

const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────────────
// Ranking configuration (single document, admin-editable).
//
// Holds the performance-scoring weights, the rolling window, minimum sample
// requirements, normalisation targets and the sponsored-placement cap. Stored
// as one well-known document (`key: 'ranking'`) so an admin can retune the
// engine from the console without a deploy, and so the change is auditable
// through AdminAuditLog.
//
// Defaults live in services/restaurantPerformanceService (DEFAULT_WEIGHTS) and
// are used whenever no document exists or a stored value is malformed, so the
// engine can never be wedged by a bad row.
// ─────────────────────────────────────────────────────────────────────

const rankingConfigSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'ranking', trim: true },

  // Weights are relative; the service normalises them to sum to 1.
  weights: {
    ratings: { type: Number, min: 0, default: 0.20 },
    completion: { type: Number, min: 0, default: 0.20 },
    preparation: { type: Number, min: 0, default: 0.15 },
    cancellation: { type: Number, min: 0, default: 0.15 },
    complaints: { type: Number, min: 0, default: 0.10 },
    repeat: { type: Number, min: 0, default: 0.10 },
    recent: { type: Number, min: 0, default: 0.10 },
  },

  // Rolling window + minimum sample requirements.
  windowDays: { type: Number, min: 1, max: 365, default: 30 },
  recentWindowDays: { type: Number, min: 1, max: 90, default: 7 },
  minOrdersForFullConfidence: { type: Number, min: 1, default: 20 },
  minReviewsForFullConfidence: { type: Number, min: 1, default: 5 },

  // Normalisation targets (the "excellent" end of each raw metric).
  targetPrepMinutes: { type: Number, min: 1, default: 25 },
  targetRating: { type: Number, min: 1, max: 5, default: 4.5 },
  neutralRating: { type: Number, min: 1, max: 5, default: 4.0 },

  // Sponsored placements: how many sponsored restaurants may be injected and
  // where. Sponsorship is a clearly-labelled boost, never a silent override.
  sponsoredEnabled: { type: Boolean, default: true },
  maxSponsoredSlots: { type: Number, min: 0, max: 20, default: 3 },
  sponsoredScoreBoost: { type: Number, min: 0, max: 50, default: 5 },

  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

module.exports = mongoose.models.RankingConfig || mongoose.model('RankingConfig', rankingConfigSchema);

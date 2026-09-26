"use strict";
const mongoose = require('mongoose');

const dataRequestSchema = new mongoose.Schema({
  requestId: { type: String, required: true, unique: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false, index: true },
  type: { type: String, enum: ['access', 'correction', 'grievance'], required: true, index: true },
  message: { type: String, required: true, trim: true, maxlength: 2000 },
  status: { type: String, enum: ['open', 'in_progress', 'resolved', 'rejected'], default: 'open', index: true },
  adminNote: { type: String, trim: true, maxlength: 2000, default: '' },
  resolvedAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false });

dataRequestSchema.index({ status: 1, createdAt: -1 });
dataRequestSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.models.DataRequest || mongoose.model('DataRequest', dataRequestSchema);

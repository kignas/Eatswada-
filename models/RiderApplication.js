'use strict';
const mongoose = require('mongoose');
const riderApplicationSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 60 },
  phone: { type: String, required: true, trim: true, unique: true },
  email: { type: String, lowercase: true, trim: true, default: '' },
  passwordHash: { type: String, required: true, select: false },
  // sha256 of the secret status token given to the applicant once at submit time. Never returned by queries.
  statusTokenHash: { type: String, select: false },
  vehicleType: { type: String, enum: ['bike', 'scooter', 'bicycle', 'car'], required: true },
  vehicleNumber: { type: String, trim: true, uppercase: true, default: '' },
  deliveryZone: { type: String, trim: true, required: true, maxlength: 80 },
  drivingLicenseNumber: { type: String, trim: true, uppercase: true, default: '', maxlength: 40 },
  vehicleRegistrationNumber: { type: String, trim: true, uppercase: true, default: '', maxlength: 40 },
  status: { type: String, enum: ['submitted', 'under_review', 'needs_changes', 'approved', 'rejected', 'withdrawn'], default: 'submitted', index: true },
  reviewNote: { type: String, default: '', maxlength: 1000 },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },
  approvedRiderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });
riderApplicationSchema.index({ status: 1, createdAt: -1 });
module.exports = mongoose.models.RiderApplication || mongoose.model('RiderApplication', riderApplicationSchema);

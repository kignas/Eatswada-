'use strict';
const asyncHandler = require('express-async-handler');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const RiderApplication = require('../models/RiderApplication');

const normalizePhone = value => String(value || '').replace(/[\s()-]/g, '').trim();
const publicShape = app => ({
  id: String(app._id), name: app.name, phone: app.phone, email: app.email,
  vehicleType: app.vehicleType, vehicleNumber: app.vehicleNumber,
  deliveryZone: app.deliveryZone, drivingLicenseNumber: app.drivingLicenseNumber,
  vehicleRegistrationNumber: app.vehicleRegistrationNumber, status: app.status,
  reviewNote: app.reviewNote, createdAt: app.createdAt, reviewedAt: app.reviewedAt,
});

exports.submitApplication = asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const phone = normalizePhone(req.body.phone);
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const vehicleType = String(req.body.vehicleType || '').trim().toLowerCase();
  const vehicleNumber = String(req.body.vehicleNumber || '').trim().toUpperCase();
  const deliveryZone = String(req.body.deliveryZone || '').trim();
  const drivingLicenseNumber = String(req.body.drivingLicenseNumber || '').trim().toUpperCase();
  const vehicleRegistrationNumber = String(req.body.vehicleRegistrationNumber || vehicleNumber).trim().toUpperCase();
  if (name.length < 2 || name.length > 60) return res.status(400).json({ success:false, message:'Enter your full name (2–60 characters).' });
  if (!/^\+?[1-9]\d{9,14}$/.test(phone)) return res.status(400).json({ success:false, message:'Enter a valid phone number with country code if needed.' });
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ success:false, message:'Enter a valid email address.' });
  if (password.length < 8 || password.length > 72) return res.status(400).json({ success:false, message:'Password must be 8–72 characters.' });
  if (!['bike','scooter','bicycle','car'].includes(vehicleType)) return res.status(400).json({ success:false, message:'Select a valid vehicle type.' });
  if (!deliveryZone || deliveryZone.length > 80) return res.status(400).json({ success:false, message:'Enter your delivery area.' });
  if (vehicleNumber.length > 20 || drivingLicenseNumber.length > 40 || vehicleRegistrationNumber.length > 40) return res.status(400).json({ success:false, message:'One or more vehicle/license fields are too long.' });
  const existingUser = await User.findOne({ $or: [{ phone }, ...(email ? [{ email }] : [])] }).select('_id role');
  if (existingUser) return res.status(409).json({ success:false, message:'An account already exists for this phone or email. Contact Eatswada support if you need help.' });
  const existingApp = await RiderApplication.findOne({ phone }).select('_id status');
  if (existingApp && !['rejected','withdrawn'].includes(existingApp.status)) return res.status(409).json({ success:false, message:'An application already exists for this phone number.', applicationId:String(existingApp._id), status:existingApp.status });
  const passwordHash = await bcrypt.hash(password, 12);
  let application;
  if (existingApp) {
    application = await RiderApplication.findByIdAndUpdate(existingApp._id, {
      $set: { name, phone, email, passwordHash, vehicleType, vehicleNumber, deliveryZone, drivingLicenseNumber, vehicleRegistrationNumber, status:'submitted', reviewNote:'', reviewedBy:null, reviewedAt:null, approvedRiderId:null }
    }, { new:true, runValidators:true }).select('+passwordHash');
  } else {
    application = await RiderApplication.create({ name, phone, email, passwordHash, vehicleType, vehicleNumber, deliveryZone, drivingLicenseNumber, vehicleRegistrationNumber });
  }
  return res.status(201).json({ success:true, message:'Application submitted. You can log in after admin approval.', data:{ id:String(application._id), status:application.status, name:application.name } });
});

exports.getApplicationStatus = asyncHandler(async (req, res) => {
  const id = String(req.params.id || '');
  const phone = normalizePhone(req.query.phone);
  if (!mongoose.Types.ObjectId.isValid(id) || !/^\+?[1-9]\d{9,14}$/.test(phone)) return res.status(400).json({ success:false, message:'Valid application ID and phone are required.' });
  const app = await RiderApplication.findOne({ _id:id, phone }).select('name status reviewNote createdAt reviewedAt');
  if (!app) return res.status(404).json({ success:false, message:'Application not found.' });
  return res.json({ success:true, data:{ id:String(app._id), name:app.name, status:app.status, reviewNote:app.reviewNote, createdAt:app.createdAt, reviewedAt:app.reviewedAt } });
});

exports.listApplications = asyncHandler(async (req, res) => {
  const status = String(req.query.status || 'submitted');
  const allowed = ['submitted','under_review','needs_changes','approved','rejected','withdrawn','all'];
  if (!allowed.includes(status)) return res.status(400).json({ success:false, message:'Invalid application status filter.' });
  const filter = status === 'all' ? {} : { status };
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const apps = await RiderApplication.find(filter).select('-passwordHash').sort({ createdAt:1 }).limit(limit).lean();
  res.json({ success:true, data:apps.map(publicShape) });
});

exports.reviewApplication = asyncHandler(async (req, res) => {
  const { action } = req.body;
  const note = String(req.body.note || '').trim().slice(0, 1000);
  if (!['under_review','needs_changes','reject','approve'].includes(action)) return res.status(400).json({ success:false, message:'Action must be under_review, needs_changes, reject or approve.' });
  const app = await RiderApplication.findById(req.params.id).select('+passwordHash');
  if (!app) return res.status(404).json({ success:false, message:'Rider application not found.' });
  if (app.status === 'approved' || app.approvedRiderId) return res.status(409).json({ success:false, message:'This application has already been approved.' });
  if (['needs_changes','reject'].includes(action) && !note) return res.status(400).json({ success:false, message:'A review note is required for this action.' });
  if (action === 'approve') {
    const existing = await User.findOne({ $or: [{ phone:app.phone }, ...(app.email ? [{ email:app.email }] : [])] }).select('_id role');
    if (existing) return res.status(409).json({ success:false, message:'A user already exists with this phone or email. Resolve the duplicate before approving.' });
    const temporaryPassword = crypto.randomBytes(32).toString('hex');
    const rider = new User({
      name:app.name, phone:app.phone, email:app.email || undefined, password:temporaryPassword,
      role:'rider', isActive:true, isPhoneVerified:false,
      riderDetails:{ vehicleType:app.vehicleType, vehicleNumber:app.vehicleNumber || undefined, deliveryZone:app.deliveryZone, isOnline:false },
    });
    await rider.save();
    try {
      // Application password was bcrypt-hashed at submission; copy that hash
      // directly so it is not double-hashed by User's pre-save hook.
      await User.updateOne({ _id:rider._id, role:'rider' }, { $set:{ password:app.passwordHash } });
      app.status = 'approved'; app.approvedRiderId = rider._id; app.reviewNote = note; app.reviewedBy = req.user._id; app.reviewedAt = new Date();
      await app.save();
    } catch (err) {
      await User.deleteOne({ _id:rider._id });
      throw err;
    }
    return res.json({ success:true, message:'Application approved. The rider can sign in using the password created during application.', data:{ application:publicShape(app), riderId:String(rider._id) } });
  }
  app.status = action === 'reject' ? 'rejected' : action;
  app.reviewNote = note; app.reviewedBy = req.user._id; app.reviewedAt = new Date();
  await app.save();
  res.json({ success:true, message:'Application review updated.', data:publicShape(app) });
});

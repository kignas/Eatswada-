'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const User = require('../models/User');
const Restaurant = require('../models/Restaurant');
const VendorApplication = require('../models/VendorApplication');

const APPLICATION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STAFF_MIN_PASSWORD = 10;

const slugify = (name) => String(name)
  .toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\w-]/g, '');

function normalizePhone(value) {
  return String(value || '').trim();
}

function validPhone(value) {
  return /^\+?[1-9]\d{9,14}$/.test(value);
}

function validLocation(location) {
  if (location === undefined || location === null) return true;
  const c = location?.coordinates;
  return Array.isArray(c) && c.length === 2 &&
    Number.isFinite(c[0]) && Number.isFinite(c[1]) &&
    c[0] >= -180 && c[0] <= 180 && c[1] >= -90 && c[1] <= 90;
}

const HOURS_DAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function normalizeHours(value) {
  const input = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const day of HOURS_DAYS) {
    const d = input[day] && typeof input[day] === 'object' ? input[day] : {};
    const closed = d.closed === true;
    const opensAt = typeof d.opensAt === 'string' && TIME_RE.test(d.opensAt) ? d.opensAt : '10:00';
    const closesAt = typeof d.closesAt === 'string' && TIME_RE.test(d.closesAt) ? d.closesAt : '22:00';
    if (!closed && opensAt === closesAt) throw new Error(`Opening and closing time cannot be the same on ${day}.`);
    out[day] = { closed, opensAt, closesAt };
  }
  return out;
}
function validMoney(v, max = 100000) {
  return Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= max;
}

function publicApplication(application, includeToken = false, token = null) {
  const out = {
    id: application._id,
    status: application.status,
    restaurantName: application.restaurantName,
    ownerName: application.ownerName,
    createdAt: application.createdAt,
    reviewedAt: application.reviewedAt,
    rejectionReason: application.status === 'rejected' ? application.rejectionReason : '',
  };
  if (includeToken && token) out.statusToken = token;
  return out;
}

function adminApplication(application) {
  const a = application.toObject({ virtuals: false });
  delete a.statusTokenHash;
  delete a.statusTokenExpiresAt;
  if (a.applicant?.password) delete a.applicant.password;
  return a;
}

async function createRestaurantForApplication(application, vendorUser) {
  const payload = {
    name: application.restaurantName,
    owner: vendorUser._id,
    cuisine: application.cuisine,
    description: application.description || '',
    phone: application.phone || '',
    address: application.address || '',
    fssaiLicenseNumber: application.fssaiLicenseNumber || '',
    openingHours: application.openingHours,
    minOrder: application.minOrder ?? 0,
    deliveryFee: application.deliveryFee ?? 40,
    freeDeliveryEnabled: application.freeDeliveryEnabled !== false,
    freeDeliveryAbove: application.freeDeliveryAbove ?? 200,
    deliveryRadiusKm: 15,
    codEnabled: false,
    isActive: true,
    availability: { isOpen: true, autoHours: false, closedReason: '' },
    ...(application.location?.coordinates ? { location: application.location } : {}),
  };

  try {
    return await Restaurant.create(payload);
  } catch (err) {
    if (err.code === 11000 && err.keyPattern?.slug) {
      return Restaurant.create({
        ...payload,
        slug: `${slugify(application.restaurantName)}-${vendorUser._id.toString().slice(-5)}`,
      });
    }
    throw err;
  }
}

/**
 * Public vendor application.
 * Creates an inactive vendor User immediately so credentials are unique and
 * securely hashed by the existing User model. No restaurant is created until
 * an admin approves the application.
 */
exports.submitVendorApplication = asyncHandler(async (req, res) => {
  const {
    ownerName, email, phone, password, restaurantName, cuisine,
    description, address, location, fssaiLicenseNumber, openingHours,
    minOrder, deliveryFee, freeDeliveryEnabled, freeDeliveryAbove,
  } = req.body || {};

  const normalizedEmail = String(email || '').toLowerCase().trim();
  const normalizedPhone = normalizePhone(phone);
  const cuisineArray = Array.isArray(cuisine)
    ? cuisine.map(v => String(v).trim()).filter(Boolean).slice(0, 10)
    : String(cuisine || '').split(',').map(v => v.trim()).filter(Boolean).slice(0, 10);

  if (!ownerName?.trim() || !restaurantName?.trim() || !normalizedEmail || !normalizedPhone || !password || !cuisineArray.length) {
    return res.status(400).json({ success: false, message: 'Owner, restaurant, contact, password, and cuisine are required.' });
  }
  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
    return res.status(400).json({ success: false, message: 'Please provide a valid email address.' });
  }
  if (!validPhone(normalizedPhone)) {
    return res.status(400).json({ success: false, message: 'Please provide a valid phone number.' });
  }
  if (password.length < STAFF_MIN_PASSWORD) {
    return res.status(400).json({ success: false, message: 'Password must be at least 10 characters.' });
  }
  if (!validLocation(location) || !location?.coordinates) {
    return res.status(400).json({ success: false, message: 'Restaurant GPS location is required.' });
  }
  if (!String(address || '').trim()) {
    return res.status(400).json({ success: false, message: 'Restaurant address is required.' });
  }
  if (!String(fssaiLicenseNumber || '').trim()) {
    return res.status(400).json({ success: false, message: 'FSSAI license / registration number is required.' });
  }
  const normalizedMinOrder = minOrder === undefined || minOrder === '' ? 0 : Number(minOrder);
  const normalizedDeliveryFee = deliveryFee === undefined || deliveryFee === '' ? 40 : Number(deliveryFee);
  const normalizedFreeAbove = freeDeliveryAbove === undefined || freeDeliveryAbove === '' ? 200 : Number(freeDeliveryAbove);
  if (!validMoney(normalizedMinOrder) || !validMoney(normalizedDeliveryFee) || !validMoney(normalizedFreeAbove)) {
    return res.status(400).json({ success: false, message: 'Order and delivery amounts must be valid non-negative values.' });
  }
  if (String(fssaiLicenseNumber || '').trim().length > 100) {
    return res.status(400).json({ success: false, message: 'FSSAI license / registration number is too long.' });
  }
  let normalizedOpeningHours;
  try { normalizedOpeningHours = normalizeHours(openingHours); }
  catch (err) { return res.status(400).json({ success: false, message: err.message || 'Invalid opening hours.' }); }

  const existingUser = await User.findOne({ $or: [{ email: normalizedEmail }, { phone: normalizedPhone }] });

  let vendorUser = existingUser;
  if (existingUser) {
    if (existingUser.role !== 'vendor' || existingUser.isActive || existingUser.restaurantId) {
      return res.status(409).json({ success: false, message: 'An account using this email or phone cannot be used for a new vendor application.' });
    }
    // Existing inactive vendor = pending/rejected application. Allow a safe re-application.
    vendorUser.name = ownerName.trim();
    vendorUser.password = password;
    vendorUser.tokenVersion = (vendorUser.tokenVersion || 0) + 1;
    await vendorUser.save();
  } else {
    vendorUser = await User.create({
      name: ownerName.trim(),
      email: normalizedEmail,
      phone: normalizedPhone,
      password,
      role: 'vendor',
      isActive: false,
      isPhoneVerified: false,
      restaurantId: null,
    });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const tokenExpires = new Date(Date.now() + APPLICATION_TOKEN_TTL_MS);

  let application = await VendorApplication.findOne({ applicant: vendorUser._id });
  if (!application) {
    application = await VendorApplication.create({
      applicant: vendorUser._id,
      restaurantName: restaurantName.trim(),
      ownerName: ownerName.trim(),
      email: normalizedEmail,
      phone: normalizedPhone,
      cuisine: cuisineArray,
      description: description || '',
      address: address || '',
      fssaiLicenseNumber: String(fssaiLicenseNumber || '').trim(),
      openingHours: normalizedOpeningHours,
      minOrder: normalizedMinOrder,
      deliveryFee: normalizedDeliveryFee,
      freeDeliveryEnabled: freeDeliveryEnabled !== false,
      freeDeliveryAbove: normalizedFreeAbove,
      ...(location ? { location } : {}),
      status: 'pending',
      rejectionReason: '',
      statusTokenHash: tokenHash,
      statusTokenExpiresAt: tokenExpires,
    });
  } else {
    if (application.status === 'approved' && application.restaurantId) {
      return res.status(409).json({ success: false, message: 'A vendor application for this account has already been approved.' });
    }
    application.restaurantName = restaurantName.trim();
    application.ownerName = ownerName.trim();
    application.email = normalizedEmail;
    application.phone = normalizedPhone;
    application.cuisine = cuisineArray;
    application.description = description || '';
    application.address = address || '';
    application.fssaiLicenseNumber = String(fssaiLicenseNumber || '').trim();
    application.openingHours = normalizedOpeningHours;
    application.minOrder = normalizedMinOrder;
    application.deliveryFee = normalizedDeliveryFee;
    application.freeDeliveryEnabled = freeDeliveryEnabled !== false;
    application.freeDeliveryAbove = normalizedFreeAbove;
    application.location = location || undefined;
    application.status = 'pending';
    application.rejectionReason = '';
    application.adminNotes = '';
    application.reviewedBy = null;
    application.reviewedAt = null;
    application.restaurantId = null;
    application.statusTokenHash = tokenHash;
    application.statusTokenExpiresAt = tokenExpires;
    await application.save();
  }

  res.status(201).json({
    success: true,
    message: 'Vendor application submitted successfully. It is now pending admin review.',
    data: publicApplication(application, true, token),
  });
});

exports.getVendorApplicationStatus = asyncHandler(async (req, res) => {
  const token = String(req.body?.statusToken || req.query?.statusToken || '').trim();
  if (!mongoose.isValidObjectId(req.params.id) || !token) {
    return res.status(400).json({ success: false, message: 'Invalid application status request.' });
  }

  const application = await VendorApplication.findById(req.params.id)
    .select('+statusTokenHash +statusTokenExpiresAt');
  if (!application) return res.status(404).json({ success: false, message: 'Application not found.' });
  if (application.statusTokenExpiresAt < new Date()) {
    return res.status(410).json({ success: false, message: 'Application status token has expired.' });
  }

  const hash = crypto.createHash('sha256').update(token).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(application.statusTokenHash))) {
    return res.status(404).json({ success: false, message: 'Application not found.' });
  }

  res.json({ success: true, data: publicApplication(application) });
});

exports.getVendorApplications = asyncHandler(async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const filter = status ? { status } : {};
  const skip = (page - 1) * limit;

  const [applications, total] = await Promise.all([
    VendorApplication.find(filter)
      .populate('applicant', 'name email phone isActive restaurantId')
      .populate('reviewedBy', 'name email')
      .populate('restaurantId', 'name slug isActive isOpen availability')
      .sort({ createdAt: -1 }).skip(skip).limit(limit),
    VendorApplication.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: applications.map(adminApplication),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

exports.getVendorApplicationById = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid application id.' });
  }
  const application = await VendorApplication.findById(req.params.id)
    .populate('applicant', 'name email phone isActive restaurantId createdAt')
    .populate('reviewedBy', 'name email')
    .populate('restaurantId', 'name slug isActive isOpen availability createdAt');
  if (!application) return res.status(404).json({ success: false, message: 'Application not found.' });
  res.json({ success: true, data: adminApplication(application) });
});

exports.approveVendorApplication = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid application id.' });
  }

  const application = await VendorApplication.findById(req.params.id).select('+statusTokenHash +statusTokenExpiresAt');
  if (!application) return res.status(404).json({ success: false, message: 'Application not found.' });
  if (application.status === 'approved') {
    return res.status(409).json({ success: false, message: 'Application is already approved.' });
  }
  if (application.status !== 'pending') {
    return res.status(409).json({ success: false, message: 'Only pending applications can be approved.' });
  }

  const vendorUser = await User.findOne({ _id: application.applicant, role: 'vendor' });
  if (!vendorUser) return res.status(409).json({ success: false, message: 'Applicant vendor account is missing.' });
  if (vendorUser.restaurantId) return res.status(409).json({ success: false, message: 'Applicant is already linked to a restaurant.' });

  const session = await mongoose.startSession();
  let restaurant;
  try {
    await session.withTransaction(async () => {
      // Re-check inside the transaction to prevent a second admin from
      // approving the same application concurrently.
      const current = await VendorApplication.findOne({ _id: application._id, status: 'pending' }).session(session);
      if (!current) throw Object.assign(new Error('APPLICATION_NOT_PENDING'), { code: 'APPLICATION_NOT_PENDING' });

      const restaurantPayload = {
        name: current.restaurantName,
        owner: vendorUser._id,
        cuisine: current.cuisine,
        description: current.description || '',
        phone: current.phone || '',
        address: current.address || '',
        fssaiLicenseNumber: current.fssaiLicenseNumber || '',
        openingHours: current.openingHours,
        minOrder: current.minOrder ?? 0,
        deliveryFee: current.deliveryFee ?? 40,
        freeDeliveryEnabled: current.freeDeliveryEnabled !== false,
        freeDeliveryAbove: current.freeDeliveryAbove ?? 200,
        ...(typeof req.body?.image === 'string' && /^https?:\/\//i.test(req.body.image.trim()) ? { image: req.body.image.trim(), images: [req.body.image.trim()] } : {}),
        deliveryRadiusKm: 15,
        codEnabled: false,
        isActive: true,
        availability: { isOpen: true, autoHours: false, closedReason: '' },
        ...(current.location?.coordinates ? { location: current.location } : {}),
      };

      restaurant = new Restaurant(restaurantPayload);
      try {
        await restaurant.save({ session });
      } catch (err) {
        if (err.code === 11000 && err.keyPattern?.slug) {
          restaurant.slug = `${slugify(current.restaurantName)}-${vendorUser._id.toString().slice(-5)}`;
          await restaurant.save({ session });
        } else throw err;
      }

      vendorUser.restaurantId = restaurant._id;
      vendorUser.isActive = true;
      vendorUser.tokenVersion = (vendorUser.tokenVersion || 0) + 1;
      await vendorUser.save({ session });

      current.status = 'approved';
      current.restaurantId = restaurant._id;
      current.reviewedBy = req.user._id;
      current.reviewedAt = new Date();
      current.rejectionReason = '';
      await current.save({ session });
    });
  } catch (err) {
    if (err.code === 'APPLICATION_NOT_PENDING') {
      return res.status(409).json({ success: false, message: 'Application was already processed by another admin.' });
    }
    throw err;
  } finally {
    await session.endSession();
  }

  res.json({
    success: true,
    message: 'Vendor application approved and restaurant activated.',
    data: { applicationId: application._id, vendorId: vendorUser._id, restaurant },
  });
});

exports.rejectVendorApplication = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid application id.' });
  }
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason) return res.status(400).json({ success: false, message: 'A rejection reason is required.' });
  if (reason.length > 1000) return res.status(400).json({ success: false, message: 'Rejection reason is too long.' });

  const application = await VendorApplication.findOneAndUpdate(
    { _id: req.params.id, status: 'pending' },
    {
      $set: {
        status: 'rejected',
        rejectionReason: reason,
        reviewedBy: req.user._id,
        reviewedAt: new Date(),
      },
    },
    { new: true }
  );

  if (!application) return res.status(409).json({ success: false, message: 'Application not found or is no longer pending.' });

  await User.findOneAndUpdate(
    { _id: application.applicant, role: 'vendor', restaurantId: null },
    { $set: { isActive: false }, $inc: { tokenVersion: 1 } }
  );

  res.json({
    success: true,
    message: 'Vendor application rejected.',
    data: publicApplication(application),
  });
});

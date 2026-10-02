'use strict';

const crypto = require('crypto');
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const User = require('../models/User');
const Restaurant = require('../models/Restaurant');
const VendorApplication = require('../models/VendorApplication');
const { commissionRateForDeliveryMode, commissionPlanForDeliveryMode } = require('../services/commissionService');

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
function normalizeRestaurantImages(body) {
  const raw = Array.isArray(body?.images)
    ? body.images
    : (typeof body?.image === 'string' ? [body.image] : []);

  return [...new Set(
    raw
      .filter(v => typeof v === 'string')
      .map(v => v.trim())
      .filter(v => /^https?:\/\//i.test(v))
  )].slice(0, 4);
}

function publicApplication(application, includeToken = false, token = null) {
  const out = {
    id: application._id,
    status: application.status,
    restaurantName: application.restaurantName,
    ownerName: application.ownerName,
    businessType: application.businessType || 'restaurant',
    deliveryMode: application.deliveryMode || 'eatswada_rider',
    createdAt: application.createdAt,
    reviewedAt: application.reviewedAt,
    rejectionReason: application.status === 'rejected' ? application.rejectionReason : '',
    changeRequest: application.status === 'needs_changes' ? application.changeRequest : '',
  };
  if (includeToken && token) out.statusToken = token;
  return out;
}

function adminApplication(application) {
  const a = application.toObject({ virtuals: false });
  delete a.statusTokenHash;
  delete a.statusTokenExpiresAt;
  // Legacy application fields are retained in MongoDB for backward compatibility,
  // but are not part of the current application review contract. Pricing and
  // commission are configured by Admin after approval.
  for (const key of ['requestedCommissionRate','minOrder','deliveryFee','freeDeliveryEnabled','freeDeliveryAbove','fssaiCertificateUrl','fssaiExpiryDate','maxActiveOrders','settlementSchedule']) delete a[key];
  if (a.applicant?.password) delete a.applicant.password;
  return a;
}


/**
 * Public vendor application.
 * Creates an inactive vendor User immediately so credentials are unique and
 * securely hashed by the existing User model. No restaurant is created until
 * an admin approves the application.
 */
exports.getVendorApplicationConfig = asyncHandler(async (req, res) => {
  res.json({ success:true, data:{
    businessTypes:[
      { key:'restaurant', label:'Restaurant' },
      { key:'cloud_kitchen', label:'Cloud kitchen' },
    ],
    deliveryModes:[
      { key:'self_delivery', label:'Self delivery' },
      { key:'eatswada_rider', label:'Eatswada delivery' },
    ],
    fssai:{ required:true, certificateUploadRequired:false },
    policies:{
      vendorAgreementVersion:String(process.env.VENDOR_AGREEMENT_VERSION || '2026-10-01'),
      vendorPrivacyPolicyVersion:String(process.env.VENDOR_PRIVACY_POLICY_VERSION || '2026-10-01'),
    },
  }});
});

exports.submitVendorApplication = asyncHandler(async (req, res) => {
  const {
    ownerName, email, phone, password, restaurantName, cuisine,
    description, address, location, fssaiLicenseNumber, openingHours,
    businessType, deliveryMode, vendorAgreementVersion, vendorAgreementAcceptedAt,
    privacyPolicyVersion, privacyPolicyAcceptedAt,
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
  const normalizedBusinessType = ['restaurant', 'cloud_kitchen'].includes(String(businessType)) ? String(businessType) : null;
  const normalizedDeliveryMode = ['self_delivery', 'eatswada_rider'].includes(String(deliveryMode)) ? String(deliveryMode) : null;
  if (!normalizedBusinessType) return res.status(400).json({ success:false, message:'businessType must be restaurant or cloud_kitchen.' });
  if (!normalizedDeliveryMode) return res.status(400).json({ success:false, message:'deliveryMode must be self_delivery or eatswada_rider.' });
  const requiredAgreement = String(process.env.VENDOR_AGREEMENT_VERSION || '').trim();
  const requiredPrivacy = String(process.env.VENDOR_PRIVACY_POLICY_VERSION || '').trim();
  if (process.env.REQUIRE_VENDOR_POLICY_ACCEPTANCE === 'true') {
    if (!requiredAgreement || vendorAgreementVersion !== requiredAgreement || !vendorAgreementAcceptedAt) return res.status(400).json({success:false,message:'Current vendor agreement must be accepted before submitting this application.'});
    if (!requiredPrivacy || privacyPolicyVersion !== requiredPrivacy || !privacyPolicyAcceptedAt) return res.status(400).json({success:false,message:'Current vendor privacy policy must be accepted before submitting this application.'});
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
      businessType: normalizedBusinessType,
      deliveryMode: normalizedDeliveryMode,
      requestedCommissionRate: commissionRateForDeliveryMode(normalizedDeliveryMode),
      vendorAgreementVersion: String(vendorAgreementVersion || '').trim().slice(0, 100),
      vendorAgreementAcceptedAt: vendorAgreementAcceptedAt ? new Date(vendorAgreementAcceptedAt) : null,
      privacyPolicyVersion: String(privacyPolicyVersion || '').trim().slice(0, 100),
      privacyPolicyAcceptedAt: privacyPolicyAcceptedAt ? new Date(privacyPolicyAcceptedAt) : null,
      address: address || '',
      fssaiLicenseNumber: String(fssaiLicenseNumber || '').trim(),
      openingHours: normalizedOpeningHours,
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
    application.businessType = normalizedBusinessType;
    application.deliveryMode = normalizedDeliveryMode;
    application.requestedCommissionRate = commissionRateForDeliveryMode(normalizedDeliveryMode);
    application.vendorAgreementVersion = String(vendorAgreementVersion || '').trim().slice(0, 100);
    application.vendorAgreementAcceptedAt = vendorAgreementAcceptedAt ? new Date(vendorAgreementAcceptedAt) : null;
    application.privacyPolicyVersion = String(privacyPolicyVersion || '').trim().slice(0, 100);
    application.privacyPolicyAcceptedAt = privacyPolicyAcceptedAt ? new Date(privacyPolicyAcceptedAt) : null;
    application.address = address || '';
    application.fssaiLicenseNumber = String(fssaiLicenseNumber || '').trim();
    application.openingHours = normalizedOpeningHours;
    application.location = location || undefined;
    application.status = 'pending';
    application.rejectionReason = '';
    application.changeRequest = '';
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
  const status = ['pending', 'needs_changes', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
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

  // Resolve the slug BEFORE opening the transaction. A duplicate-key error
  // inside a MongoDB transaction aborts that transaction permanently; retrying
  // restaurant.save({ session }) in the same transaction then produces the
  // misleading `Transaction ... has been aborted` error that previously made
  // approval look like a generic server failure. The owner-id suffix gives us
  // a deterministic collision-safe fallback without ever retrying a failed
  // insert inside the aborted transaction.
  const baseSlug = slugify(application.restaurantName) || `restaurant-${vendorUser._id.toString().slice(-8)}`;
  let restaurantSlug = baseSlug;
  const baseSlugExists = await Restaurant.exists({ slug: baseSlug });
  if (baseSlugExists) {
    restaurantSlug = `${baseSlug}-${vendorUser._id.toString().slice(-8)}`;
  }

  const session = await mongoose.startSession();
  let restaurant;
  try {
    await session.withTransaction(async () => {
      // Re-check inside the transaction to prevent a second admin from
      // approving the same application concurrently.
      const current = await VendorApplication.findOne({ _id: application._id, status: 'pending' }).session(session);
      if (!current) throw Object.assign(new Error('APPLICATION_NOT_PENDING'), { code: 'APPLICATION_NOT_PENDING' });

      const restaurantImages = normalizeRestaurantImages(req.body);

      const restaurantPayload = {
        name: current.restaurantName,
        owner: vendorUser._id,
        cuisine: current.cuisine,
        description: current.description || '',
        phone: current.phone || '',
        address: current.address || '',
        fssaiLicenseNumber: current.fssaiLicenseNumber || '',
        fssaiVerificationStatus: 'pending',
        businessType: current.businessType || 'restaurant',
        deliveryMode: current.deliveryMode || 'eatswada_rider',
        commissionPlan: commissionPlanForDeliveryMode(current.deliveryMode || 'eatswada_rider'),
        commissionRate: commissionRateForDeliveryMode(current.deliveryMode || 'eatswada_rider'),
        maxActiveOrders: 20,
        settlementSchedule: 'weekly',
        openingHours: current.openingHours,
        // minOrder/deliveryFee/free-delivery are intentionally omitted here.
        // Restaurant schema defaults apply; Admin owns these settings after approval.
        ...(restaurantImages.length ? { image: restaurantImages[0], images: restaurantImages } : {}),
        deliveryRadiusKm: 10,
        codEnabled: false,
        isActive: true,
        availability: { isOpen: true, autoHours: false, closedReason: '' },
        slug: restaurantSlug,
        approvedBy: req.user._id,
        approvedAt: new Date(),
        ...(current.location?.coordinates ? { location: current.location } : {}),
      };

      restaurant = new Restaurant(restaurantPayload);
      // Do not catch a duplicate-key error and retry here. MongoDB marks the
      // transaction as aborted as soon as the duplicate insert occurs.
      await restaurant.save({ session });

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


exports.requestVendorApplicationChanges = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid application id.' });
  }
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) return res.status(400).json({ success: false, message: 'A change request message is required.' });
  if (message.length > 1000) return res.status(400).json({ success: false, message: 'Change request cannot exceed 1000 characters.' });

  const application = await VendorApplication.findOneAndUpdate(
    { _id: req.params.id, status: 'pending' },
    { $set: { status: 'needs_changes', changeRequest: message, reviewedBy: req.user._id, reviewedAt: new Date() } },
    { new: true, runValidators: true }
  );
  if (!application) return res.status(409).json({ success: false, message: 'Application not found or is no longer pending.' });
  res.json({ success: true, message: 'Changes requested from applicant.', data: publicApplication(application) });
});

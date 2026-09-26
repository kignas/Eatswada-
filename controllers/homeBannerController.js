'use strict';

const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const HomeBanner = require('../models/HomeBanner');
const { logAdminAction } = require('../services/auditService');
const { createMemoryCache, readTtlMs } = require('../utils/memoryCache');

const ANIMATIONS = new Set(['fade', 'slide', 'scale', 'none']);
const TEXT_COLORS = new Set(['light', 'dark']);
const HEADER_THEMES = new Set(['anime', 'pink', 'lavender', 'magenta']);
const PLACEMENTS = new Set(['home', 'under99']);

function validBackground(value) {
  if (!value) return true;
  const v = String(value).trim();
  return /^(#[0-9a-f]{3,8}|rgba?\([^)]{1,120}\)|hsla?\([^)]{1,120}\)|(?:linear|radial)-gradient\(.{1,260}\))$/i.test(v);
}

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanPayload(body = {}) {
  const payload = {};
  const stringFields = ['title', 'subtitle', 'offerText', 'badgeText', 'ctaText', 'ctaUrl', 'image', 'mobileImage', 'background', 'headerTheme', 'searchPlaceholder'];
  stringFields.forEach((key) => {
    if (body[key] !== undefined) payload[key] = clean(body[key], key === 'image' || key === 'mobileImage' ? 1000 : key === 'ctaUrl' ? 300 : 140);
  });
  if (body.placement !== undefined) payload.placement = clean(body.placement, 20).toLowerCase();
  if (body.textColor !== undefined) payload.textColor = clean(body.textColor, 10).toLowerCase();
  if (body.headerTheme !== undefined) payload.headerTheme = clean(body.headerTheme, 20).toLowerCase();
  if (body.animation !== undefined) payload.animation = clean(body.animation, 20).toLowerCase();
  if (body.active !== undefined) payload.active = Boolean(body.active);
  if (body.priority !== undefined) payload.priority = Number(body.priority);
  if (body.startAt !== undefined) payload.startAt = body.startAt || null;
  if (body.endAt !== undefined) payload.endAt = body.endAt || null;
  return payload;
}

function validatePayload(payload, { partial = false } = {}) {
  if (!partial && !payload.title) return 'Title is required.';
  if (!partial && !payload.image) return 'Desktop image is required.';
  if (payload.placement !== undefined && !PLACEMENTS.has(payload.placement)) return 'Invalid banner placement.';
  if (payload.animation !== undefined && !ANIMATIONS.has(payload.animation)) return 'Invalid animation type.';
  if (payload.textColor !== undefined && !TEXT_COLORS.has(payload.textColor)) return 'Invalid text color.';
  if (payload.headerTheme !== undefined && !HEADER_THEMES.has(payload.headerTheme)) return 'Invalid header theme.';
  if (payload.background !== undefined && !validBackground(payload.background)) return 'Background must be a valid color or simple CSS gradient.';
  if (payload.priority !== undefined && (!Number.isFinite(payload.priority) || payload.priority < 0 || payload.priority > 9999)) return 'Priority must be between 0 and 9999.';
  if (payload.ctaUrl) {
    const url = payload.ctaUrl;
    if (!((url.startsWith('/') && !url.startsWith('//')) || /^https:\/\//i.test(url))) return 'CTA URL must be a relative path or an HTTPS URL.';
  }
  if (payload.startAt && Number.isNaN(new Date(payload.startAt).getTime())) return 'Invalid start date.';
  if (payload.endAt && Number.isNaN(new Date(payload.endAt).getTime())) return 'Invalid end date.';
  if (payload.startAt && payload.endAt && new Date(payload.endAt) < new Date(payload.startAt)) return 'End date cannot be before start date.';
  return null;
}

const PUBLIC_BANNER_FIELDS = 'placement title subtitle offerText badgeText ctaText ctaUrl image mobileImage background textColor animation headerTheme searchPlaceholder priority';

// PERFORMANCE: GET /api/home-banners is identical for every customer and runs
// on every homepage / ₹99-page load, but banners only change when an admin
// edits them. The active banners of each placement are kept in memory
// (default 60 s, HOME_BANNER_CACHE_TTL_MS=0 disables) and every admin write
// below clears the cache immediately.
//
// The start/end schedule is NOT frozen by the cache: startAt/endAt are loaded
// with the cached rows and the time window is applied on EVERY request, with
// the same rules the MongoDB filter used —
//   { startAt: null } matches null or missing; { startAt: { $lte: now } } only
//   matches real dates (and the same for endAt with $gte) —
// so a scheduled banner still appears/disappears at exactly the same moment.
// startAt/endAt are removed again before responding, so the JSON is unchanged.
const bannerCache = createMemoryCache({ ttlMs: readTtlMs('HOME_BANNER_CACHE_TTL_MS', 60000) });
const invalidateBannerCache = () => bannerCache.invalidate();

const isDateValue = (value) => Object.prototype.toString.call(value) === '[object Date]';

function isWithinSchedule(banner, now) {
  const startOk = banner.startAt == null || (isDateValue(banner.startAt) && banner.startAt.getTime() <= now.getTime());
  const endOk = banner.endAt == null || (isDateValue(banner.endAt) && banner.endAt.getTime() >= now.getTime());
  return startOk && endOk;
}

exports.getActiveBanners = asyncHandler(async (req, res) => {
  const now = new Date();
  const placement = String(req.query.placement || 'home').trim().toLowerCase();
  if (!PLACEMENTS.has(placement)) return res.status(400).json({ success: false, message: 'Invalid banner placement.' });

  if (!bannerCache.enabled) {
    // Cache disabled: the original query, unchanged.
    const banners = await HomeBanner.find({
      placement,
      active: true,
      $and: [
        { $or: [{ startAt: null }, { startAt: { $lte: now } }] },
        { $or: [{ endAt: null }, { endAt: { $gte: now } }] },
      ],
    })
      .select(PUBLIC_BANNER_FIELDS)
      .sort({ priority: -1, createdAt: -1 })
      .lean();

    return res.json({ success: true, data: banners });
  }

  const candidates = await bannerCache.get(placement, () =>
    HomeBanner.find({ placement, active: true })
      .select(`${PUBLIC_BANNER_FIELDS} startAt endAt`)
      .sort({ priority: -1, createdAt: -1 })
      .lean()
  );

  const banners = [];
  for (const banner of candidates) {
    if (!isWithinSchedule(banner, now)) continue;
    // New object per response: the cached rows are never mutated or exposed.
    const { startAt, endAt, ...publicFields } = banner;
    banners.push(publicFields);
  }

  res.json({ success: true, data: banners });
});

exports.getAllBanners = asyncHandler(async (req, res) => {
  const banners = await HomeBanner.find({}).sort({ priority: -1, createdAt: -1 }).lean();
  res.json({ success: true, data: banners });
});

exports.createBanner = asyncHandler(async (req, res) => {
  const payload = cleanPayload(req.body);
  const error = validatePayload(payload);
  if (error) return res.status(400).json({ success: false, message: error });

  payload.createdBy = req.user._id;
  payload.updatedBy = req.user._id;
  const banner = await HomeBanner.create(payload);
  invalidateBannerCache();

  await logAdminAction(req, {
    action: 'home_banner.create',
    targetType: 'home_banner',
    targetId: banner._id,
    targetLabel: banner.title,
    newValue: banner.toObject(),
  });

  res.status(201).json({ success: true, data: banner });
});

exports.updateBanner = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid banner ID.' });
  const banner = await HomeBanner.findById(req.params.id);
  if (!banner) return res.status(404).json({ success: false, message: 'Banner not found.' });

  const oldValue = banner.toObject();
  const payload = cleanPayload(req.body);
  const error = validatePayload(payload, { partial: true });
  if (error) return res.status(400).json({ success: false, message: error });

  Object.assign(banner, payload, { updatedBy: req.user._id });
  await banner.save();
  invalidateBannerCache();

  await logAdminAction(req, {
    action: 'home_banner.update',
    targetType: 'home_banner',
    targetId: banner._id,
    targetLabel: banner.title,
    oldValue,
    newValue: banner.toObject(),
  });

  res.json({ success: true, data: banner });
});

exports.toggleBanner = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid banner ID.' });
  const banner = await HomeBanner.findById(req.params.id);
  if (!banner) return res.status(404).json({ success: false, message: 'Banner not found.' });

  const previous = banner.active;
  banner.active = !banner.active;
  banner.updatedBy = req.user._id;
  await banner.save();
  invalidateBannerCache();

  await logAdminAction(req, {
    action: 'home_banner.toggle',
    targetType: 'home_banner',
    targetId: banner._id,
    targetLabel: banner.title,
    oldValue: { active: previous },
    newValue: { active: banner.active },
  });

  res.json({ success: true, data: { active: banner.active } });
});

exports.deleteBanner = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid banner ID.' });
  const banner = await HomeBanner.findById(req.params.id);
  if (!banner) return res.status(404).json({ success: false, message: 'Banner not found.' });
  const oldValue = banner.toObject();
  await banner.deleteOne();
  invalidateBannerCache();

  await logAdminAction(req, {
    action: 'home_banner.delete',
    targetType: 'home_banner',
    targetId: banner._id,
    targetLabel: banner.title,
    oldValue,
  });

  res.json({ success: true, message: 'Banner deleted.' });
});

exports.reorderBanners = asyncHandler(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ success: false, message: 'items must be a non-empty array.' });

  const operations = [];
  for (const item of items) {
    if (!mongoose.isValidObjectId(item.id)) continue;
    const priority = Number(item.priority);
    if (!Number.isFinite(priority) || priority < 0 || priority > 9999) continue;
    operations.push({ updateOne: { filter: { _id: item.id }, update: { $set: { priority, updatedBy: req.user._id } } } });
  }
  if (!operations.length) return res.status(400).json({ success: false, message: 'No valid banner order items supplied.' });
  try {
    await HomeBanner.bulkWrite(operations);
  } finally {
    // Also on failure: a bulkWrite can be partially applied before it throws.
    invalidateBannerCache();
  }
  const banners = await HomeBanner.find({}).sort({ priority: -1, createdAt: -1 }).lean();
  res.json({ success: true, data: banners });
});

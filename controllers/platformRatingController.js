'use strict';

const asyncHandler = require('express-async-handler');
const PlatformRating = require('../models/PlatformRating');

const MAX_RATINGS_PER_USER = 3;

const getMyRatings = asyncHandler(async (req, res) => {
  const ratings = await PlatformRating.find({ user: req.user._id })
    .select('_id score comment createdAt')
    .sort({ createdAt: -1 })
    .limit(MAX_RATINGS_PER_USER);

  res.json({
    success: true,
    data: {
      ratings,
      used: ratings.length,
      remaining: Math.max(0, MAX_RATINGS_PER_USER - ratings.length),
      max: MAX_RATINGS_PER_USER,
    },
  });
});

const submitPlatformRating = asyncHandler(async (req, res) => {
  const score = Number(req.body?.score);
  const comment = String(req.body?.comment || '').trim().slice(0, 500);

  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return res.status(400).json({ success: false, message: 'Please choose a rating from 1 to 5.' });
  }

  // The unique (user, sequence) index makes the lifetime cap safe even if
  // two browser tabs submit at nearly the same time.
  const usedRatings = await PlatformRating.find({ user: req.user._id }).select('sequence').sort({ sequence: 1 }).lean();
  let used = usedRatings.length;
  if (used >= MAX_RATINGS_PER_USER) {
    return res.status(429).json({
      success: false,
      message: `You have used all ${MAX_RATINGS_PER_USER} Rate Us submissions.`,
      data: { used, remaining: 0, max: MAX_RATINGS_PER_USER },
    });
  }

  const chooseSequence = rows => {
    const taken = new Set(rows.map(x => Number(x.sequence)));
    for (let i = 1; i <= MAX_RATINGS_PER_USER; i += 1) if (!taken.has(i)) return i;
    return null;
  };

  let sequence = chooseSequence(usedRatings);
  let rating;
  for (let attempt = 0; attempt < 2 && !rating; attempt += 1) {
    try {
      rating = await PlatformRating.create({ user: req.user._id, sequence, score, comment });
    } catch (err) {
      if (err?.code !== 11000) throw err;
      const latest = await PlatformRating.find({ user: req.user._id }).select('sequence').sort({ sequence: 1 }).lean();
      used = latest.length;
      if (used >= MAX_RATINGS_PER_USER) {
        return res.status(429).json({ success: false, message: `You have used all ${MAX_RATINGS_PER_USER} Rate Us submissions.`, data: { used, remaining: 0, max: MAX_RATINGS_PER_USER } });
      }
      sequence = chooseSequence(latest);
    }
  }

  if (!rating) {
    return res.status(409).json({ success: false, message: 'Your rating could not be saved. Please try again.' });
  }
  used = await PlatformRating.countDocuments({ user: req.user._id });

  res.status(201).json({
    success: true,
    message: 'Thanks for rating Eatswada!',
    data: {
      rating,
      used: used + 1,
      remaining: Math.max(0, MAX_RATINGS_PER_USER - used - 1),
      max: MAX_RATINGS_PER_USER,
    },
  });
});

const getPlatformRatings = asyncHandler(async (req, res) => {
  const requestedLimit = Number(req.query.limit);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 50, 1), 100);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const skip = (page - 1) * limit;

  const [rows, total, summary] = await Promise.all([
    PlatformRating.find({})
      .populate('user', 'name phone email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    PlatformRating.countDocuments({}),
    PlatformRating.aggregate([
      { $group: { _id: null, average: { $avg: '$score' }, count: { $sum: 1 } } },
    ]),
  ]);

  const distribution = await PlatformRating.aggregate([
    { $group: { _id: '$score', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);

  const avg = summary[0]?.average || 0;

  res.json({
    success: true,
    data: rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    summary: {
      average: Math.round(avg * 10) / 10,
      count: summary[0]?.count || 0,
      distribution: Object.fromEntries(distribution.map(x => [String(x._id), x.count])),
    },
  });
});

module.exports = { getMyRatings, submitPlatformRating, getPlatformRatings, MAX_RATINGS_PER_USER };

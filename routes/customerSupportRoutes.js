'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { protect, authorize } = require('../middleware/authMiddleware');
const controller = require('../controllers/customerSupportController');
const router = express.Router();

// `max` (not `limit`) so this works on express-rate-limit v6 AND v7+, same as server.js.
const keyGenerator = (req) => String(req.user?._id || req.ip);

// Sending things (create / reply / close): strict.
const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, keyGenerator,
  message: { success: false, message: 'Too many support messages. Please wait before trying again.' },
});

// Reading (chat polling every ~5s, unread badge): generous, so an open chat never gets blocked.
const readLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, keyGenerator,
  message: { success: false, message: 'Refreshing too fast. Please slow down.' },
});

router.use(protect, authorize('user'));

// Must stay above '/tickets/:id' so "unread-count" is not read as an id.
router.get('/tickets/unread-count', readLimiter, controller.unreadCount);
router.get('/tickets', readLimiter, controller.listMyTickets);
router.get('/tickets/:id', readLimiter, controller.getMyTicket);

router.post('/tickets', writeLimiter, controller.createTicket);
router.post('/tickets/:id/messages', writeLimiter, controller.replyMyTicket);
router.patch('/tickets/:id/close', writeLimiter, controller.closeMyTicket);
router.post('/tickets/:id/typing', readLimiter, controller.setTyping);

module.exports = router;

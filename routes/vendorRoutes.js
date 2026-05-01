const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { updateRestaurantStatus } = require('../controllers/vendorController');

// The route the Master Switch hits when the owner taps it
router.put('/status', protect, updateRestaurantStatus);

module.exports = router;

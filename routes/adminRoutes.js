const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { getAllRestaurants, createMasterItem } = require('../controllers/adminController');

router.get('/restaurants', protect, getAllRestaurants);
router.post('/menu', protect, createMasterItem);

module.exports = router;

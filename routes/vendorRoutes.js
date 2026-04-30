const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware'); // The bouncer that checks JWTs
const { getVendorOrders, getVendorMenu, addMenuItem, updateMenuItem } = require('../controllers/vendorController');

// All routes here are protected by JWT authentication
router.get('/orders', protect, getVendorOrders);
router.get('/menu', protect, getVendorMenu);
router.post('/menu', protect, addMenuItem);
router.put('/menu/:id', protect, updateMenuItem);

module.exports = router;

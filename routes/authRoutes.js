const express = require("express");
const router = express.Router();

const { vendorLogin, createVendor } = require("../controllers/authController");
const { protect, authorize } = require("../middleware/authMiddleware");

router.post("/vendor/login", vendorLogin);

// ADMIN ONLY — no public vendor signup exists or should exist.
router.post("/admin/create-vendor", protect, authorize("admin"), createVendor);

module.exports = router;

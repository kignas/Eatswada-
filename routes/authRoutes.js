const express = require("express");
const router = express.Router();

const { vendorLogin, adminLogin, createVendor, riderLogin } = require("../controllers/authController");
const { protect, authorize } = require("../middleware/authMiddleware");

router.post("/vendor/login", vendorLogin);
router.post("/admin/login", adminLogin);
router.post("/rider/login", riderLogin);

// ADMIN ONLY — no public vendor signup exists or should exist.
router.post("/admin/create-vendor", protect, authorize("admin"), createVendor);

module.exports = router;

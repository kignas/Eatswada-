const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const { vendorLogin, adminLogin, createVendor, riderLogin } = require("../controllers/authController");
const { setupAdmin } = require("../controllers/setupController");
const { protect, authorize } = require("../middleware/authMiddleware");

// SECURITY FIX: Rate Limiter to prevent brute-force attacks on login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per window
  message: { 
    success: false, 
    message: "Too many login attempts from this IP, please try again after 15 minutes." 
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// Apply the limiter ONLY to login routes
router.post("/vendor/login", loginLimiter, vendorLogin);
router.post("/admin/login", loginLimiter, adminLogin);
router.post("/rider/login", loginLimiter, riderLogin);

// ADMIN ONLY — no public vendor signup exists or should exist.
router.post("/admin/create-vendor", protect, authorize("admin"), createVendor);


// TEMPORARY — create the first admin account.
// Protected by ADMIN_SETUP_KEY.
// Remove this route after creating the admin.
router.post("/setup-admin", setupAdmin);

module.exports = router;

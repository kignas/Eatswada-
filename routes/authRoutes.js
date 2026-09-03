const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const { vendorLogin, createVendor, riderLogin } = require("../controllers/authController");
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
router.post("/rider/login", loginLimiter, riderLogin);
// NOTE: admin login lives at POST /api/admin/login (routes/adminRoutes.js).
// The duplicate that used to sit here was removed — two login endpoints for
// the same account with different rate limits is how one of them gets
// forgotten, and the forgotten one was the unprotected one.

// ADMIN ONLY — no public vendor signup exists or should exist.
router.post("/admin/create-vendor", protect, authorize("admin"), createVendor);

// FIRST-ADMIN BOOTSTRAP — disabled unless explicitly switched on.
//
// The route only exists when ENABLE_ADMIN_SETUP=true is set in the
// environment. Normal operation runs with it unset, so the endpoint is not
// mounted at all and returns 404 — there is nothing to brute-force.
//
// To create the very first admin (or recover after losing the account):
//   1. Set ENABLE_ADMIN_SETUP=true and a long random ADMIN_SETUP_KEY on Render.
//   2. Create the admin through Admin/setup-admin.html.
//   3. Remove both variables. The route disappears on the next restart.
if (process.env.ENABLE_ADMIN_SETUP === "true") {
  const setupAdminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
  });

  console.warn("⚠️  ENABLE_ADMIN_SETUP is true — POST /api/auth/setup-admin is live. Turn it off once your admin exists.");
  router.post("/setup-admin", setupAdminLimiter, setupAdmin);
}

module.exports = router;

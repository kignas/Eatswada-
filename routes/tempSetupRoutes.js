/**
 * tempSetupRoutes.js
 * ------------------------------------------------------------------
 * ⚠️ TEMPORARY ONE-TIME SETUP ROUTE — DELETE AFTER USE ⚠️
 *
 * Creates the FIRST Nearbite admin account, then refuses every request
 * after that (even if this file is still deployed).
 *
 * Setup:
 *   1. Place this file in your routes/ folder.
 *   2. In your main server file (app.js / server.js / index.js), add:
 *        app.use('/api/setup', require('./routes/tempSetupRoutes'));
 *   3. On Render → your service → Environment, add a variable:
 *        ADMIN_SETUP_KEY = some-long-random-string-you-invent
 *      (Don't put this value in any file. Set it only in Render's dashboard.)
 *   4. Push to GitHub → Render redeploys.
 *   5. Use the companion setup-admin.html page to call this route.
 *   6. Once you're logged into the Admin Panel successfully:
 *        - delete this file
 *        - remove the app.use('/api/setup', ...) line
 *        - delete the ADMIN_SETUP_KEY env var on Render
 *        - push again to redeploy without any of it
 * ------------------------------------------------------------------
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const User = require('../models/User'); // 🔧 adjust path if your models folder is elsewhere

router.post('/create-admin', async (req, res) => {
  try {
    // 1. Verify the secret key (header, not body/URL, so it isn't logged as easily)
    const providedKey = req.headers['x-setup-key'] || '';
    const expectedKey = process.env.ADMIN_SETUP_KEY || '';

    const keysMatch =
      expectedKey.length > 0 &&
      providedKey.length === expectedKey.length &&
      crypto.timingSafeEqual(Buffer.from(providedKey), Buffer.from(expectedKey));

    if (!keysMatch) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    // 2. Self-disabling check — refuse if an admin already exists
    const existingAdmin = await User.findOne({ role: 'admin' });
    if (existingAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Setup already completed. An admin account already exists.',
      });
    }

    // 3. Validate input
    const { name, phone, email, password } = req.body;
    if (!phone || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'phone, email, and password are required.',
      });
    }

    // 4. Create the admin — plain-text password on purpose.
    // Your User model's pre('save') hook hashes it automatically.
    const admin = new User({
      name: name || 'Nearbite Admin',
      phone,
      email,
      password,
      role: 'admin',
      isActive: true,
      isPhoneVerified: true,
    });

    await admin.save();

    return res.status(201).json({
      success: true,
      message: 'Admin created. Log in now, then delete this route.',
      admin: { name: admin.name, email: admin.email, phone: admin.phone },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'That phone number or email is already in use.',
      });
    }
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map((e) => e.message);
      return res.status(400).json({ success: false, message: messages.join(' ') });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

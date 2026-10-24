const asyncHandler = require("express-async-handler");
const crypto = require("crypto");
const User = require("../models/User");
const AdminSetupClaim = require("../models/AdminSetupClaim");
const { FULL_ACCESS } = require("../middleware/permissionMiddleware");

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

exports.setupAdmin = asyncHandler(async (req, res) => {
  // ---------------------------------------------------------
  // 1. Check setup key
  // ---------------------------------------------------------
  const setupKey = process.env.ADMIN_SETUP_KEY;

  if (!setupKey) {
    return res.status(503).json({
      success: false,
      message: "Admin setup is not configured on the server."
    });
  }

  const suppliedKey = String(req.get("x-setup-key") || "");

  if (!suppliedKey || !safeEqual(suppliedKey, setupKey)) {
    return res.status(403).json({
      success: false,
      message: "Invalid setup key."
    });
  }

  // ---------------------------------------------------------
  // 2. Get admin information
  // ---------------------------------------------------------
  const { name, email, phone, password } = req.body;

  if (!name || !email || !phone || !password) {
    return res.status(400).json({
      success: false,
      message: "Name, email, phone and password are required."
    });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedPhone = String(phone).trim();

  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
    return res.status(400).json({
      success: false,
      message: "Please enter a valid email address."
    });
  }

  if (!/^\+?[1-9]\d{9,14}$/.test(normalizedPhone)) {
    return res.status(400).json({
      success: false,
      message: "Please enter a valid phone number."
    });
  }

  // This creates the highest-privilege account on the platform.
  if (String(password).length < 12) {
    return res.status(400).json({
      success: false,
      message: "Password must be at least 12 characters."
    });
  }

  // ---------------------------------------------------------
  // 3. Check existing accounts before claiming the one-time bootstrap.
  // A second check after the claim protects against a concurrent out-of-band
  // admin creation. The claim's unique _id serializes concurrent setup calls.
  // ---------------------------------------------------------
  const existingAdmin = await User.findOne({ role: "admin" });

  if (existingAdmin) {
    return res.status(409).json({
      success: false,
      message: "An admin account already exists. Use the normal admin login."
    });
  }

  const existingUser = await User.findOne({
    $or: [{ email: normalizedEmail }, { phone: normalizedPhone }]
  });

  if (existingUser) {
    return res.status(409).json({
      success: false,
      message: "This email or phone number is already registered to another account."
    });
  }

  // MongoDB enforces uniqueness on _id. Only one concurrent request can claim
  // the singleton bootstrap record; it is retained after successful creation.
  try {
    await AdminSetupClaim.create({ _id: "initial-admin" });
  } catch (error) {
    if (error?.code === 11000 || error?.code === 11001) {
      return res.status(409).json({
        success: false,
        message: "Admin setup has already been claimed. Use the normal admin login."
      });
    }
    throw error;
  }

  try {
    const adminAppeared = await User.findOne({ role: "admin" });
    if (adminAppeared) {
      await AdminSetupClaim.deleteOne({ _id: "initial-admin" });
      return res.status(409).json({ success: false, message: "An admin account already exists. Use the normal admin login." });
    }

    // IMPORTANT: User.js has a pre-save bcrypt hook, so password is hashed.
    const admin = await User.create({
      name: String(name).trim(),
      email: normalizedEmail,
      phone: normalizedPhone,
      password: String(password),
      role: "admin",
      permissions: [FULL_ACCESS],
      isActive: true,
      isPhoneVerified: true,
      restaurantId: null
    });

    return res.status(201).json({
      success: true,
      message: "Admin account created successfully.",
      admin: {
        _id: admin._id,
        name: admin.name,
        email: admin.email,
        phone: admin.phone,
        role: admin.role,
        isActive: admin.isActive
      }
    });
  } catch (error) {
    // Do not release the claim if an admin now exists: the write may have
    // committed even if the caller saw a later error. This avoids reopening
    // bootstrap after an ambiguous write result.
    const adminExists = await User.findOne({ role: "admin" }).catch(() => null);
    if (!adminExists) await AdminSetupClaim.deleteOne({ _id: "initial-admin" }).catch(() => {});
    throw error;
  }
});

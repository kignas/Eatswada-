const asyncHandler = require("express-async-handler");
const User = require("../models/User");

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

  if (!suppliedKey || suppliedKey !== setupKey) {
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

  if (String(password).length < 6) {
    return res.status(400).json({
      success: false,
      message: "Password must be at least 6 characters."
    });
  }

  // ---------------------------------------------------------
  // 3. Make sure another admin does not already exist
  // ---------------------------------------------------------
  const existingAdmin = await User.findOne({ role: "admin" });

  if (existingAdmin) {
    return res.status(409).json({
      success: false,
      message:
        "An admin account already exists. Use the normal admin login or remove the existing admin first."
    });
  }

  // ---------------------------------------------------------
  // 4. Make sure email/phone are not already used
  // ---------------------------------------------------------
  const existingUser = await User.findOne({
    $or: [
      { email: normalizedEmail },
      { phone: normalizedPhone }
    ]
  });

  if (existingUser) {
    return res.status(409).json({
      success: false,
      message:
        "This email or phone number is already registered to another account."
    });
  }

  // ---------------------------------------------------------
  // 5. Create admin
  //
  // IMPORTANT:
  // User.js has a pre-save bcrypt hook.
  // Therefore password will be hashed automatically.
  // ---------------------------------------------------------
  const admin = await User.create({
    name: String(name).trim(),
    email: normalizedEmail,
    phone: normalizedPhone,
    password: String(password),
    role: "admin",
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
});

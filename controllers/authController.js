const asyncHandler = require("express-async-handler");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const Restaurant = require("../models/Restaurant");
const generateToken = require("../utils/generateToken");

exports.vendorLogin = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      message: "Email and password are required."
    });
  }

  // Password is select:false in your User model
  const user = await User.findOne({
    email: email.toLowerCase().trim(),
    role: "vendor"
  }).select("+password");

  if (!user) {
    return res.status(401).json({
      success: false,
      message: "Invalid email or password."
    });
  }

  if (!user.isActive) {
    return res.status(403).json({
      success: false,
      message: "Your account has been disabled."
    });
  }

  const isMatch = await bcrypt.compare(password, user.password);

  if (!isMatch) {
    return res.status(401).json({
      success: false,
      message: "Invalid email or password."
    });
  }

  const restaurant = await Restaurant.findById(user.restaurantId);

  if (!restaurant) {
    return res.status(403).json({
      success: false,
      message: "Restaurant is not linked to this vendor."
    });
  }

  res.json({
    success: true,
    token: generateToken(user._id),
    user: {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role
    },
    restaurant
  });
});

exports.adminLogin = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      message: "Email and password are required."
    });
  }

  // Password is select:false in your User model
  const user = await User.findOne({
    email: email.toLowerCase().trim(),
    role: "admin"
  }).select("+password");

  if (!user) {
    return res.status(401).json({
      success: false,
      message: "Invalid email or password."
    });
  }

  if (!user.isActive) {
    return res.status(403).json({
      success: false,
      message: "Your account has been disabled."
    });
  }

  const isMatch = await bcrypt.compare(password, user.password);

  if (!isMatch) {
    return res.status(401).json({
      success: false,
      message: "Invalid email or password."
    });
  }

  res.json({
    success: true,
    token: generateToken(user._id),
    user: {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role
    }
  });
});

exports.riderLogin = asyncHandler(async (req, res) => {
  const { phone, email, password } = req.body;

  if ((!phone && !email) || !password) {
    return res.status(400).json({
      success: false,
      message: "Phone (or email) and password are required."
    });
  }

  // Password is select:false in your User model
  const query = { role: "rider" };
  if (phone) query.phone = String(phone).trim();
  else query.email = String(email).toLowerCase().trim();

  const rider = await User.findOne(query).select("+password");

  if (!rider || !rider.password) {
    return res.status(401).json({
      success: false,
      message: "Invalid credentials."
    });
  }

  if (!rider.isActive) {
    return res.status(403).json({
      success: false,
      message: "Your account has been disabled. Please contact support."
    });
  }

  const isMatch = await bcrypt.compare(password, rider.password);

  if (!isMatch) {
    return res.status(401).json({
      success: false,
      message: "Invalid credentials."
    });
  }

  rider.lastLogin = new Date();
  await rider.save();

  res.json({
    success: true,
    token: generateToken(rider._id),
    user: {
      _id: rider._id,
      name: rider.name,
      email: rider.email,
      phone: rider.phone,
      role: rider.role,
      avatar: rider.avatar,
      isActive: rider.isActive,
      riderDetails: rider.riderDetails
    }
  });
});

/**
 * createVendor — ADMIN ONLY.
 *
 * Mounted behind `protect, authorize('admin')` in authRoutes.js.
 * There is deliberately no public/self-serve equivalent of this endpoint.
 *
 * Two supported flows:
 *  1. New restaurant:      pass restaurantName + cuisine (no restaurantId)
 *  2. Existing restaurant: pass restaurantId, skip restaurant fields
 *
 * Creation order matters: Restaurant.owner is a required ref to User, so the
 * vendor User is created FIRST (with restaurantId: null), then the Restaurant
 * is created with owner = vendorUser._id, then the User is updated with the
 * new restaurantId. If restaurant creation fails, the vendor User is rolled
 * back so no orphaned account is left behind.
 */
// Mirrors the slug derivation in Restaurant.js's pre('save') hook, used only
// as a fallback when the derived slug collides with an existing one.
const slugify = (name) =>
  name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '');

exports.createVendor = asyncHandler(async (req, res) => {
  const {
    // vendor (User) fields
    vendorName,
    vendorEmail,
    vendorPhone,
    vendorPassword,
    // restaurant target: either attach to an existing one...
    restaurantId,
    reassignOwner, // must be explicitly true to replace an existing owner
    // ...or create a new one
    restaurantName,
    cuisine,
    description,
    phone,
    address,
    image,
    images,
    categories,
    rating,
    ratingCount,
    estimatedDeliveryMin,
    estimatedDeliveryMax,
    distanceMeters,
    minOrder,
    deliveryFee,
    freeDeliveryEnabled,
    freeDeliveryAbove,
    deliveryRadiusKm,
    codEnabled,
    isFeatured,
    isBestSeller,
    isNearFast,
    homeOrder,
    displayPriority,
    isVeg,
    openingHours,
    location,
  } = req.body;

  // ── Validate vendor credentials ──
  if (!vendorEmail || !vendorPhone || !vendorPassword) {
    return res.status(400).json({
      success: false,
      message: "vendorEmail, vendorPhone, and vendorPassword are required.",
    });
  }

  if (vendorPassword.length < 6) {
    return res.status(400).json({
      success: false,
      message: "Password must be at least 6 characters.",
    });
  }

  const normalizedEmail = vendorEmail.toLowerCase().trim();
  const normalizedPhone = vendorPhone.trim();

  // ── Reject duplicate email or phone up front (both unique on User) ──
  const existingUser = await User.findOne({
    $or: [{ email: normalizedEmail }, { phone: normalizedPhone }],
  });

  if (existingUser) {
    return res.status(409).json({
      success: false,
      message: "A user with this email or phone number already exists.",
    });
  }

  // ── Validate location up front — coordinates feed a 2dsphere index,
  //     so a bad value would otherwise only surface deep inside save(). ──
  if (location !== undefined) {
    const coords = location?.coordinates;
    const [lng, lat] = Array.isArray(coords) ? coords : [];
    const validLng = typeof lng === "number" && lng >= -180 && lng <= 180;
    const validLat = typeof lat === "number" && lat >= -90 && lat <= 90;
    if (!Array.isArray(coords) || coords.length !== 2 || !validLng || !validLat) {
      return res.status(400).json({
        success: false,
        message: "location.coordinates must be [longitude, latitude] with longitude in [-180,180] and latitude in [-90,90].",
      });
    }
  }

  // ── Resolve target restaurant: reuse existing, or validate inputs for a new one ──
  let restaurant = null;
  let isNewRestaurant = false;
  let previousOwnerId = null;

  if (restaurantId) {
    restaurant = await Restaurant.findById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "restaurantId provided but no matching restaurant was found.",
      });
    }
    if (!restaurant.isActive) {
      return res.status(409).json({
        success: false,
        message: "This restaurant is deactivated (soft-deleted) and cannot accept a vendor.",
      });
    }
    // `owner` is required on every Restaurant document, so it is ALWAYS set —
    // reassignment must be explicit rather than inferred from an empty owner.
    if (restaurant.owner && !reassignOwner) {
      return res.status(409).json({
        success: false,
        message: "This restaurant already has an owner. Pass reassignOwner: true to replace it.",
      });
    }
    if (restaurant.owner) {
      previousOwnerId = restaurant.owner;
    }
  } else {
    const cuisineArray = Array.isArray(cuisine)
      ? cuisine.filter(Boolean)
      : cuisine
      ? [cuisine]
      : [];

    if (!restaurantName?.trim() || cuisineArray.length === 0) {
      return res.status(400).json({
        success: false,
        message: "restaurantName and at least one cuisine value are required when creating a new restaurant.",
      });
    }
    isNewRestaurant = true;
  }

  // ── Step 1: create the vendor User first (Restaurant.owner needs this _id) ──
  let vendorUser;
  try {
    vendorUser = await User.create({
      name: vendorName?.trim() || "Nearbite Vendor",
      email: normalizedEmail,
      phone: normalizedPhone,
      password: vendorPassword, // hashed by the User pre('save') hook — do not hash here
      role: "vendor",
      isActive: true,
      isPhoneVerified: true,
      restaurantId: restaurant ? restaurant._id : null,
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      message: `Could not create vendor user: ${err.message}`,
    });
  }

  // ── Step 2: create (or link) the restaurant, with rollback on failure ──
  try {
    if (isNewRestaurant) {
      const cuisineArray = Array.isArray(cuisine)
        ? cuisine.filter(Boolean)
        : [cuisine];

      const restaurantPayload = {
        name: restaurantName.trim(),
        owner: vendorUser._id,
        cuisine: cuisineArray,
        description: description || "",
        phone: phone || vendorPhone || "",
        address: address || "",
        image: image || (Array.isArray(images) ? images[0] : "") || "",
        images: Array.isArray(images) ? images.filter(Boolean).slice(0, 4) : (image ? [image] : []),
        categories: Array.isArray(categories) ? categories : [],
        rating: rating ?? 4,
        ratingCount: ratingCount ?? 0,
        estimatedDeliveryMin: estimatedDeliveryMin ?? 30,
        estimatedDeliveryMax: estimatedDeliveryMax ?? 40,
        distanceMeters: distanceMeters ?? 2000,
        minOrder: minOrder ?? 0,
        deliveryFee: deliveryFee ?? 40,
        freeDeliveryEnabled: freeDeliveryEnabled ?? true,
        freeDeliveryAbove: freeDeliveryAbove ?? 200,
        deliveryRadiusKm: deliveryRadiusKm ?? 15,
        codEnabled: codEnabled === true,
        isFeatured: isFeatured === true,
        isBestSeller: isBestSeller === true,
        isNearFast: isNearFast === true,
        homeOrder: Number.isFinite(Number(homeOrder)) && Number(homeOrder) >= 1 ? Math.min(999999, Number(homeOrder)) : 999999,
        displayPriority: Number.isFinite(Number(displayPriority)) ? Number(displayPriority) : 0,
        isVeg: !!isVeg,
        ...(openingHours ? { openingHours } : {}),
        ...(location ? { location } : {}),
      };

      try {
        restaurant = await Restaurant.create(restaurantPayload);
      } catch (createErr) {
        // slug is unique + auto-derived from name — a same-named restaurant
        // collides here. Retry once with a disambiguated slug.
        if (createErr.code === 11000 && createErr.keyPattern?.slug) {
          restaurant = await Restaurant.create({
            ...restaurantPayload,
            slug: `${slugify(restaurantName)}-${vendorUser._id.toString().slice(-5)}`,
          });
        } else {
          throw createErr;
        }
      }

      vendorUser.restaurantId = restaurant._id;
      await vendorUser.save();
    } else {
      restaurant.owner = vendorUser._id;
      await restaurant.save();

      // Reassignment: strip the restaurantId from the previous owner so two
      // vendor accounts never point at the same restaurant simultaneously.
      if (previousOwnerId && String(previousOwnerId) !== String(vendorUser._id)) {
        await User.findByIdAndUpdate(previousOwnerId, { restaurantId: null });
      }
    }
  } catch (err) {
    // Roll back the vendor user — never leave a restaurant-less vendor account behind.
    await User.findByIdAndDelete(vendorUser._id);
    return res.status(400).json({
      success: false,
      message: `Could not create/link restaurant: ${err.message}`,
    });
  }

  res.status(201).json({
    success: true,
    message: "Vendor account created successfully.",
    vendor: {
      _id: vendorUser._id,
      name: vendorUser.name,
      email: vendorUser.email,
      phone: vendorUser.phone,
      role: vendorUser.role,
      restaurantId: vendorUser.restaurantId,
    },
    restaurant,
  });
});

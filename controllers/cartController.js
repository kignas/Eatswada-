const Cart       = require('../models/Cart');
const MenuItem   = require('../models/Menu');
const Restaurant = require('../models/Restaurant');
const asyncHandler = require('express-async-handler');

// GET /api/cart
const getCart = asyncHandler(async (req, res) => {
  const cart = await Cart.findOne({ user: req.user._id })
    .populate('restaurant', 'name image deliveryFee freeDeliveryAbove')
    .populate('deliveryAddress');
  if (!cart) return res.json({ success: true, data: null });
  res.json({ success: true, data: cart });
});

// POST /api/cart/add
const addToCart = asyncHandler(async (req, res) => {
  const { menuItemId, quantity = 1, customizations = {} } = req.body;

  const menuItem = await MenuItem.findById(menuItemId).populate('restaurant');
  if (!menuItem || !menuItem.isAvailable)
    return res.status(404).json({ success: false, message: 'Item not available' });

  let cart = await Cart.findOne({ user: req.user._id });

  // If cart belongs to a different restaurant, clear it first (Swiggy/Zomato behaviour)
  if (cart && cart.restaurant && String(cart.restaurant) !== String(menuItem.restaurant._id)) {
    cart.items = [];
    cart.restaurant = null;
    cart.restaurantName = '';
  }

  if (!cart) {
    cart = new Cart({ user: req.user._id });
  }

  cart.restaurant     = menuItem.restaurant._id;
  cart.restaurantName = menuItem.restaurant.name;

  const existing = cart.items.find(i => String(i.menuItem) === menuItemId);
  if (existing) {
    existing.quantity += Number(quantity);
  } else {
    cart.items.push({
      menuItem: menuItem._id,
      name:     menuItem.name,
      price:    menuItem.price,
      image:    menuItem.image,
      isVeg:    menuItem.isVeg,
      quantity: Number(quantity),
      customizations,
    });
  }

  await cart.save();
  res.json({ success: true, data: cart });
});

// PUT /api/cart/update
const updateCartItem = asyncHandler(async (req, res) => {
  const { menuItemId, quantity } = req.body;
  const cart = await Cart.findOne({ user: req.user._id });
  if (!cart) return res.status(404).json({ success: false, message: 'Cart not found' });

  const idx = cart.items.findIndex(i => String(i.menuItem) === menuItemId);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Item not in cart' });

  if (quantity <= 0) {
    cart.items.splice(idx, 1);
  } else {
    cart.items[idx].quantity = Number(quantity);
  }

  // Clear restaurant ref if cart is now empty
  if (cart.items.length === 0) {
    cart.restaurant = null;
    cart.restaurantName = '';
  }

  await cart.save();
  res.json({ success: true, data: cart });
});

// DELETE /api/cart/item/:menuItemId
const removeFromCart = asyncHandler(async (req, res) => {
  const cart = await Cart.findOne({ user: req.user._id });
  if (!cart) return res.status(404).json({ success: false, message: 'Cart not found' });

  cart.items = cart.items.filter(i => String(i.menuItem) !== req.params.menuItemId);
  if (cart.items.length === 0) { cart.restaurant = null; cart.restaurantName = ''; }

  await cart.save();
  res.json({ success: true, data: cart });
});

// DELETE /api/cart/clear
const clearCart = asyncHandler(async (req, res) => {
  await Cart.findOneAndUpdate(
    { user: req.user._id },
    { items: [], restaurant: null, restaurantName: '', subtotal: 0, total: 0 }
  );
  res.json({ success: true, message: 'Cart cleared' });
});

// PATCH /api/cart/address
const setDeliveryAddress = asyncHandler(async (req, res) => {
  const { addressId } = req.body;
  const cart = await Cart.findOneAndUpdate(
    { user: req.user._id },
    { deliveryAddress: addressId },
    { new: true }
  ).populate('deliveryAddress');
  res.json({ success: true, data: cart });
});

// PATCH /api/cart/payment
const setPaymentMethod = asyncHandler(async (req, res) => {
  const { paymentMethod } = req.body;
  const valid = ['upi', 'card', 'cod', 'wallet'];
  if (!valid.includes(paymentMethod))
    return res.status(400).json({ success: false, message: 'Invalid payment method' });
  const cart = await Cart.findOneAndUpdate(
    { user: req.user._id },
    { paymentMethod },
    { new: true }
  );
  res.json({ success: true, data: cart });
});

module.exports = { getCart, addToCart, updateCartItem, removeFromCart, clearCart, setDeliveryAddress, setPaymentMethod };
  

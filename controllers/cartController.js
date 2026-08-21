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
  if (!menuItem || menuItem.inStock === false)
    return res.status(404).json({ success: false, message: 'Item not available' });
  if (!menuItem.restaurant || !menuItem.restaurant.isActive || menuItem.restaurant.availability?.isOpen === false)
    return res.status(409).json({ success: false, message: 'This restaurant is currently closed.' });

  const requestedQuantity = Number(quantity);
  if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1 || requestedQuantity > 99)
    return res.status(400).json({ success: false, message: 'Quantity must be an integer between 1 and 99.' });

  let cart = await Cart.findOne({ user: req.user._id });

  if (!cart) {
    cart = new Cart({ user: req.user._id });
  }

  // SECURITY FIX: Prevent multi-restaurant carts.
  // Reject the request and tell the frontend to ask the user if they want to clear their cart.
  if (cart.restaurant && cart.items.length > 0 && String(cart.restaurant) !== String(menuItem.restaurant._id)) {
    return res.status(409).json({ 
      success: false, 
      message: 'Your cart contains items from another restaurant. Please clear your cart first.',
      requiresClear: true 
    });
  }

  cart.restaurant     = menuItem.restaurant._id;
  cart.restaurantName = menuItem.restaurant.name;

  const existing = cart.items.find(i => String(i.menuItem) === menuItemId);
  if (existing) {
    existing.quantity += requestedQuantity;
  } else {
    cart.items.push({
      menuItem: menuItem._id,
      name:     menuItem.name,
      price:    menuItem.price,
      originalPrice: (Number(menuItem.originalPrice) > Number(menuItem.price)) ? Number(menuItem.originalPrice) : null,
      image:    menuItem.image,
      isVeg:    menuItem.isVeg,
      quantity: requestedQuantity,
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

  const cart = await Cart.findOne({ user: req.user._id });
  if (!cart || !cart.restaurant)
    return res.status(404).json({ success: false, message: 'Cart or restaurant not found' });

  const restaurant = await Restaurant.findById(cart.restaurant).select('codEnabled isActive availability isOpen');
  if (!restaurant || !restaurant.isActive)
    return res.status(404).json({ success: false, message: 'Restaurant not found or unavailable' });

  if (paymentMethod === 'cod' && restaurant.codEnabled !== true)
    return res.status(403).json({ success: false, message: 'Cash on Delivery is not available for this restaurant.' });

  cart.paymentMethod = paymentMethod;
  await cart.save();
  res.json({ success: true, data: cart });
});

module.exports = { getCart, addToCart, updateCartItem, removeFromCart, clearCart, setDeliveryAddress, setPaymentMethod };

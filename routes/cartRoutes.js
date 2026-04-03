const express = require('express');
const router  = express.Router();
const { body } = require('express-validator');

const {
  getCart, addToCart, updateCartItem,
  removeFromCart, clearCart,
  setDeliveryAddress, setPaymentMethod,
} = require('../controllers/cartController');

const { protect } = require('../middleware/authMiddleware');
const validate    = require('../middleware/validateMiddleware');

router.use(protect); // all cart routes require auth

router.get   ('/',                 getCart);
router.post  ('/add',
  [body('menuItemId').notEmpty().withMessage('menuItemId is required')],
  validate, addToCart
);
router.put   ('/update',           updateCartItem);
router.delete('/item/:menuItemId', removeFromCart);
router.delete('/clear',            clearCart);
router.patch ('/address',          setDeliveryAddress);
router.patch ('/payment',          setPaymentMethod);

module.exports = router;

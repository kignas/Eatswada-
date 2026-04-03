/**
 * seeder.js — seed sample restaurants + menu items into MongoDB
 * Usage (from project root): npm run seed
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const mongoose   = require('mongoose');
const connectDB  = require('../config/db');
const Restaurant = require('../models/Restaurant');
const MenuItem   = require('../models/Menu');
const User       = require('../models/User');

// ── Sample Restaurants (matching index.html frontend data) ────
const restaurants = [
  {
    name: "Ruby's Swader Prantik",
    image: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=600&auto=format&fit=crop&q=80',
    cuisine: ['Bengali', 'Indian'],
    cuisineDisplay: 'Bengali, Indian',
    rating: 4.5, ratingCount: '200+',
    time: '20-30 mins', distance: '0.8 km',
    offer: '20% OFF up to ₹50',
    isVeg: false, isOpen: true, isFeatured: true,
    categories: ['Bengali', 'Indian', 'Lunch', 'Thali'],
    address: 'Main Road, Maynaguri',
    minOrder: 80, deliveryFee: 40, freeDeliveryAbove: 200, platformFee: 5,
  },
  {
    name: 'Burger King',
    image: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=600&auto=format&fit=crop&q=80',
    cuisine: ['Burgers', 'Fast Food', 'American'],
    cuisineDisplay: 'Burgers, Fast Food',
    rating: 4.2, ratingCount: '500+',
    time: '25-35 mins', distance: '1.2 km',
    offer: 'Buy 1 Get 1 Free',
    isVeg: false, isOpen: true, isFeatured: false,
    categories: ['Burgers', 'Fast Food', 'Snacks'],
    address: 'Station Road, Maynaguri',
    minOrder: 99, deliveryFee: 30, freeDeliveryAbove: 200, platformFee: 5,
  },
  {
    name: 'Biryani Zone',
    image: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=600&auto=format&fit=crop&q=80',
    cuisine: ['Biryani', 'Mughlai', 'Non-Veg'],
    cuisineDisplay: 'Biryani, Mughlai',
    rating: 4.6, ratingCount: '1K+',
    time: '30-40 mins', distance: '2.0 km',
    offer: 'FREE drink with every biryani',
    isVeg: false, isOpen: true, isFeatured: true,
    categories: ['Biryani', 'Non-Veg', 'Rice'],
    address: 'College Road, Maynaguri',
    minOrder: 120, deliveryFee: 40, freeDeliveryAbove: 250, platformFee: 5,
  },
  {
    name: 'Pizza Palace',
    image: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=600&auto=format&fit=crop&q=80',
    cuisine: ['Pizza', 'Italian', 'Pasta'],
    cuisineDisplay: 'Pizza, Italian',
    rating: 4.3, ratingCount: '300+',
    time: '35-45 mins', distance: '1.8 km',
    offer: '₹80 OFF on first order',
    isVeg: true, isOpen: true, isFeatured: false,
    categories: ['Pizza', 'Italian', 'Veg'],
    address: 'Subhash Nagar, Maynaguri',
    minOrder: 150, deliveryFee: 35, freeDeliveryAbove: 200, platformFee: 5,
  },
  {
    name: 'Momos Hut',
    image: 'https://images.unsplash.com/photo-1625398407796-82650a8c135f?w=600&auto=format&fit=crop&q=80',
    cuisine: ['Momos', 'Chinese', 'Tibetan'],
    cuisineDisplay: 'Momos, Chinese',
    rating: 4.4, ratingCount: '800+',
    time: '15-25 mins', distance: '0.5 km',
    offer: '10% OFF on orders above ₹149',
    isVeg: false, isOpen: true, isFeatured: true,
    categories: ['Momos', 'Chinese', 'Snacks'],
    address: 'Bus Stand, Maynaguri',
    minOrder: 60, deliveryFee: 20, freeDeliveryAbove: 150, platformFee: 5,
  },
];

// ── Menu Items per restaurant (index matches restaurants array) ─
const menuData = [
  // Index 0 — Ruby's Swader Prantik
  [
    { name: 'Dhokar Dalna', price: 90, isVeg: true, category: 'Main Course', isBestseller: true, description: 'Fried lentil cakes in spiced gravy', image: 'https://images.unsplash.com/photo-1565958011703-44f9829ba187?w=300' },
    { name: 'Luchi (4 pcs)', price: 40, isVeg: true, category: 'Breads', isUnder99: true, description: 'Deep-fried fluffy wheat bread', image: 'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=300' },
    { name: 'Mutton Curry', price: 180, isVeg: false, category: 'Main Course', isBestseller: true, description: 'Slow-cooked mutton in Bengali spices', image: 'https://images.unsplash.com/photo-1574894709920-11b28e7367e3?w=300' },
    { name: 'Mishti Doi', price: 40, isVeg: true, category: 'Dessert', isUnder99: true, description: 'Sweet Bengali yogurt', image: 'https://images.unsplash.com/photo-1488477181946-6428a0291777?w=300' },
    { name: 'Aloo Posto', price: 80, isVeg: true, category: 'Main Course', isUnder99: true, description: 'Potatoes in poppy seed paste', image: 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=300' },
    { name: 'Cholar Dal', price: 70, isVeg: true, category: 'Dal', isUnder99: true, description: 'Bengal gram lentil with coconut', image: 'https://images.unsplash.com/photo-1546833998-877b37c2e5c6?w=300' },
    { name: 'Fish Curry', price: 150, isVeg: false, category: 'Main Course', isBestseller: true, description: 'Rohu fish in mustard gravy', image: 'https://images.unsplash.com/photo-1559847844-5315695dadae?w=300' },
    { name: 'Steamed Rice', price: 30, isVeg: true, category: 'Rice', isUnder99: true, description: 'Plain steamed basmati rice', image: 'https://images.unsplash.com/photo-1536304929831-ee1ca9d44906?w=300' },
  ],
  // Index 1 — Burger King
  [
    { name: 'Veg Burger', price: 99, isVeg: true, category: 'Burgers', isUnder99: true, description: 'Crispy veg patty with fresh veggies', image: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=300' },
    { name: 'Chicken Zinger', price: 149, isVeg: false, category: 'Burgers', isBestseller: true, description: 'Crispy spicy chicken fillet burger', image: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086?w=300' },
    { name: 'Loaded Fries', price: 79, isVeg: true, category: 'Sides', isUnder99: true, description: 'Fries with cheese sauce and jalapeños', image: 'https://images.unsplash.com/photo-1576107232684-1279f390859f?w=300' },
    { name: 'Chicken Nuggets (6 pcs)', price: 99, isVeg: false, category: 'Sides', isUnder99: true, isBestseller: true, description: 'Golden crispy chicken nuggets', image: 'https://images.unsplash.com/photo-1562967916-eb82221dfb92?w=300' },
    { name: 'Whopper', price: 199, isVeg: false, category: 'Burgers', isBestseller: true, description: 'Flame-grilled beef-style burger', image: 'https://images.unsplash.com/photo-1550547660-d9450f859349?w=300' },
    { name: 'Soft Drink', price: 49, isVeg: true, category: 'Beverages', isUnder99: true, description: 'Chilled Coke / Sprite / Fanta', image: 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=300' },
  ],
  // Index 2 — Biryani Zone
  [
    { name: 'Chicken Biryani', price: 99, isVeg: false, category: 'Biryani', isBestseller: true, isUnder99: true, description: 'Aromatic basmati rice with tender chicken', image: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=300' },
    { name: 'Mutton Biryani', price: 180, isVeg: false, category: 'Biryani', isBestseller: true, description: 'Slow-cooked mutton dum biryani', image: 'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=300' },
    { name: 'Veg Biryani', price: 89, isVeg: true, category: 'Biryani', isUnder99: true, description: 'Mixed vegetable dum biryani', image: 'https://images.unsplash.com/photo-1596797038530-2c107229654b?w=300' },
    { name: 'Egg Biryani', price: 99, isVeg: false, category: 'Biryani', isUnder99: true, description: 'Egg and basmati rice dum cooked', image: 'https://images.unsplash.com/photo-1589302168068-964664d93dc0?w=300' },
    { name: 'Chicken Kebab', price: 149, isVeg: false, category: 'Starters', isBestseller: true, description: 'Minced chicken seekh kebab', image: 'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0?w=300' },
    { name: 'Raita', price: 30, isVeg: true, category: 'Sides', isUnder99: true, description: 'Boondi raita with spices', image: 'https://images.unsplash.com/photo-1588166524941-3bf61a9c41db?w=300' },
    { name: 'Soft Drink', price: 40, isVeg: true, category: 'Beverages', isUnder99: true, description: 'Chilled Coke / Sprite', image: 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=300' },
  ],
  // Index 3 — Pizza Palace
  [
    { name: 'Margherita', price: 99, isVeg: true, category: 'Pizzas', isUnder99: true, description: 'Classic tomato sauce, mozzarella, basil', image: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=300' },
    { name: 'Paneer Tikka Pizza', price: 169, isVeg: true, category: 'Pizzas', isBestseller: true, description: 'Spiced paneer, capsicum, onions', image: 'https://images.unsplash.com/photo-1571407970349-bc81e7e96d47?w=300' },
    { name: 'Farm House', price: 189, isVeg: true, category: 'Pizzas', description: 'Loaded veggie pizza with corn & mushroom', image: 'https://images.unsplash.com/photo-1565299507177-b0ac66763828?w=300' },
    { name: 'Garlic Bread', price: 79, isVeg: true, category: 'Sides', isUnder99: true, isBestseller: true, description: 'Toasted garlic butter bread sticks', image: 'https://images.unsplash.com/photo-1573140247632-f8fd74997d5c?w=300' },
    { name: 'Pasta Arrabbiata', price: 149, isVeg: true, category: 'Pasta', description: 'Penne pasta in spicy tomato sauce', image: 'https://images.unsplash.com/photo-1555949258-eb67b1ef0ceb?w=300' },
    { name: 'Cold Coffee', price: 79, isVeg: true, category: 'Beverages', isUnder99: true, description: 'Blended iced coffee with cream', image: 'https://images.unsplash.com/photo-1517701550927-30cf4ba1dba5?w=300' },
  ],
  // Index 4 — Momos Hut
  [
    { name: 'Veg Steamed Momos (8 pcs)', price: 70, isVeg: true, category: 'Momos', isUnder99: true, isBestseller: true, description: 'Soft steamed momos with mixed veg filling', image: 'https://images.unsplash.com/photo-1625398407796-82650a8c135f?w=300' },
    { name: 'Chicken Steamed Momos (8 pcs)', price: 90, isVeg: false, category: 'Momos', isBestseller: true, isUnder99: true, description: 'Juicy chicken momos steamed to perfection', image: 'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb?w=300' },
    { name: 'Fried Momos (6 pcs)', price: 80, isVeg: true, category: 'Momos', isUnder99: true, description: 'Crispy golden fried momos', image: 'https://images.unsplash.com/photo-1625398407796-82650a8c135f?w=300' },
    { name: 'Paneer Momos (8 pcs)', price: 95, isVeg: true, category: 'Momos', isUnder99: true, description: 'Paneer and herb filled steamed momos', image: 'https://images.unsplash.com/photo-1625398407796-82650a8c135f?w=300' },
    { name: 'Chilli Chicken', price: 130, isVeg: false, category: 'Starters', isBestseller: true, description: 'Indo-Chinese crispy chilli chicken', image: 'https://images.unsplash.com/photo-1603133872878-684f208fb84b?w=300' },
    { name: 'Veg Noodles', price: 89, isVeg: true, category: 'Noodles', isUnder99: true, description: 'Hakka noodles with stir-fried veggies', image: 'https://images.unsplash.com/photo-1557872943-16a5ac26437e?w=300' },
    { name: 'Schezwan Sauce (extra)', price: 10, isVeg: true, category: 'Add-ons', isUnder99: true, description: 'Extra spicy schezwan dipping sauce', image: 'https://images.unsplash.com/photo-1455619452474-d2be8b1e70cd?w=300' },
  ],
];

/**
 * seeder.js — seed sample restaurants + menu items into MongoDB
 * Usage (from project root): npm run seed
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const mongoose   = require('mongoose');
const connectDB  = require('../config/db');
const Restaurant = require('../models/Restaurant');
const MenuItem   = require('../models/Menu');
const User       = require('../models/User');

// ── Sample Restaurants (matching index.html frontend data) ────
const restaurants = [
  {
    name: "Ruby's Swader Prantik",
    image: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=600&auto=format&fit=crop&q=80',
    cuisine: ['Bengali', 'Indian'],
    cuisineDisplay: 'Bengali, Indian',
    rating: 4.5, ratingCount: '200+',
    time: '20-30 mins', distance: '0.8 km',
    offer: '20% OFF up to ₹50',
    isVeg: false, isOpen: true, isFeatured: true,
    categories: ['Bengali', 'Indian', 'Lunch', 'Thali'],
    address: 'Main Road, Maynaguri',
    minOrder: 80, deliveryFee: 40, freeDeliveryAbove: 200, platformFee: 5,
  },
  {
    name: 'Burger King',
    image: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=600&auto=format&fit=crop&q=80',
    cuisine: ['Burgers', 'Fast Food', 'American'],
    cuisineDisplay: 'Burgers, Fast Food',
    rating: 4.2, ratingCount: '500+',
    time: '25-35 mins', distance: '1.2 km',
    offer: 'Buy 1 Get 1 Free',
    isVeg: false, isOpen: true, isFeatured: false,
    categories: ['Burgers', 'Fast Food', 'Snacks'],
    address: 'Station Road, Maynaguri',
    minOrder: 99, deliveryFee: 30, freeDeliveryAbove: 200, platformFee: 5,
  },
  {
    name: 'Biryani Zone',
    image: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=600&auto=format&fit=crop&q=80',
    cuisine: ['Biryani', 'Mughlai', 'Non-Veg'],
    cuisineDisplay: 'Biryani, Mughlai',
    rating: 4.6, ratingCount: '1K+',
    time: '30-40 mins', distance: '2.0 km',
    offer: 'FREE drink with every biryani',
    isVeg: false, isOpen: true, isFeatured: true,
    categories: ['Biryani', 'Non-Veg', 'Rice'],
    address: 'College Road, Maynaguri',
    minOrder: 120, deliveryFee: 40, freeDeliveryAbove: 250, platformFee: 5,
  },
  {
    name: 'Pizza Palace',
    image: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=600&auto=format&fit=crop&q=80',
    cuisine: ['Pizza', 'Italian', 'Pasta'],
    cuisineDisplay: 'Pizza, Italian',
    rating: 4.3, ratingCount: '300+',
    time: '35-45 mins', distance: '1.8 km',
    offer: '₹80 OFF on first order',
    isVeg: true, isOpen: true, isFeatured: false,
    categories: ['Pizza', 'Italian', 'Veg'],
    address: 'Subhash Nagar, Maynaguri',
    minOrder: 150, deliveryFee: 35, freeDeliveryAbove: 200, platformFee: 5,
  },
  {
    name: 'Momos Hut',
    image: 'https://images.unsplash.com/photo-1625398407796-82650a8c135f?w=600&auto=format&fit=crop&q=80',
    cuisine: ['Momos', 'Chinese', 'Tibetan'],
    cuisineDisplay: 'Momos, Chinese',
    rating: 4.4, ratingCount: '800+',
    time: '15-25 mins', distance: '0.5 km',
    offer: '10% OFF on orders above ₹149',
    isVeg: false, isOpen: true, isFeatured: true,
    categories: ['Momos', 'Chinese', 'Snacks'],
    address: 'Bus Stand, Maynaguri',
    minOrder: 60, deliveryFee: 20, freeDeliveryAbove: 150, platformFee: 5,
  },
];

// ── Menu Items per restaurant (index matches restaurants array) ─
const menuData = [
  // Index 0 — Ruby's Swader Prantik
  [
    { name: 'Dhokar Dalna', price: 90, isVeg: true, category: 'Main Course', isBestseller: true, description: 'Fried lentil cakes in spiced gravy', image: 'https://images.unsplash.com/photo-1565958011703-44f9829ba187?w=300' },
    { name: 'Luchi (4 pcs)', price: 40, isVeg: true, category: 'Breads', isUnder99: true, description: 'Deep-fried fluffy wheat bread', image: 'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=300' },
    { name: 'Mutton Curry', price: 180, isVeg: false, category: 'Main Course', isBestseller: true, description: 'Slow-cooked mutton in Bengali spices', image: 'https://images.unsplash.com/photo-1574894709920-11b28e7367e3?w=300' },
    { name: 'Mishti Doi', price: 40, isVeg: true, category: 'Dessert', isUnder99: true, description: 'Sweet Bengali yogurt', image: 'https://images.unsplash.com/photo-1488477181946-6428a0291777?w=300' },
    { name: 'Aloo Posto', price: 80, isVeg: true, category: 'Main Course', isUnder99: true, description: 'Potatoes in poppy seed paste', image: 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=300' },
    { name: 'Cholar Dal', price: 70, isVeg: true, category: 'Dal', isUnder99: true, description: 'Bengal gram lentil with coconut', image: 'https://images.unsplash.com/photo-1546833998-877b37c2e5c6?w=300' },
    { name: 'Fish Curry', price: 150, isVeg: false, category: 'Main Course', isBestseller: true, description: 'Rohu fish in mustard gravy', image: 'https://images.unsplash.com/photo-1559847844-5315695dadae?w=300' },
    { name: 'Steamed Rice', price: 30, isVeg: true, category: 'Rice', isUnder99: true, description: 'Plain steamed basmati rice', image: 'https://images.unsplash.com/photo-1536304929831-ee1ca9d44906?w=300' },
  ],
  // Index 1 — Burger King
  [
    { name: 'Veg Burger', price: 99, isVeg: true, category: 'Burgers', isUnder99: true, description: 'Crispy veg patty with fresh veggies', image: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=300' },
    { name: 'Chicken Zinger', price: 149, isVeg: false, category: 'Burgers', isBestseller: true, description: 'Crispy spicy chicken fillet burger', image: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086?w=300' },
    { name: 'Loaded Fries', price: 79, isVeg: true, category: 'Sides', isUnder99: true, description: 'Fries with cheese sauce and jalapeños', image: 'https://images.unsplash.com/photo-1576107232684-1279f390859f?w=300' },
    { name: 'Chicken Nuggets (6 pcs)', price: 99, isVeg: false, category: 'Sides', isUnder99: true, isBestseller: true, description: 'Golden crispy chicken nuggets', image: 'https://images.unsplash.com/photo-1562967916-eb82221dfb92?w=300' },
    { name: 'Whopper', price: 199, isVeg: false, category: 'Burgers', isBestseller: true, description: 'Flame-grilled beef-style burger', image: 'https://images.unsplash.com/photo-1550547660-d9450f859349?w=300' },
    { name: 'Soft Drink', price: 49, isVeg: true, category: 'Beverages', isUnder99: true, description: 'Chilled Coke / Sprite / Fanta', image: 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=300' },
  ],
  // Index 2 — Biryani Zone
  [
    { name: 'Chicken Biryani', price: 99, isVeg: false, category: 'Biryani', isBestseller: true, isUnder99: true, description: 'Aromatic basmati rice with tender chicken', image: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=300' },
    { name: 'Mutton Biryani', price: 180, isVeg: false, category: 'Biryani', isBestseller: true, description: 'Slow-cooked mutton dum biryani', image: 'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=300' },
    { name: 'Veg Biryani', price: 89, isVeg: true, category: 'Biryani', isUnder99: true, description: 'Mixed vegetable dum biryani', image: 'https://images.unsplash.com/photo-1596797038530-2c107229654b?w=300' },
    { name: 'Egg Biryani', price: 99, isVeg: false, category: 'Biryani', isUnder99: true, description: 'Egg and basmati rice dum cooked', image: 'https://images.unsplash.com/photo-1589302168068-964664d93dc0?w=300' },
    { name: 'Chicken Kebab', price: 149, isVeg: false, category: 'Starters', isBestseller: true, description: 'Minced chicken seekh kebab', image: 'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0?w=300' },
    { name: 'Raita', price: 30, isVeg: true, category: 'Sides', isUnder99: true, description: 'Boondi raita with spices', image: 'https://images.unsplash.com/photo-1588166524941-3bf61a9c41db?w=300' },
    { name: 'Soft Drink', price: 40, isVeg: true, category: 'Beverages', isUnder99: true, description: 'Chilled Coke / Sprite', image: 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=300' },
  ],
  // Index 3 — Pizza Palace
  [
    { name: 'Margherita', price: 99, isVeg: true, category: 'Pizzas', isUnder99: true, description: 'Classic tomato sauce, mozzarella, basil', image: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=300' },
    { name: 'Paneer Tikka Pizza', price: 169, isVeg: true, category: 'Pizzas', isBestseller: true, description: 'Spiced paneer, capsicum, onions', image: 'https://images.unsplash.com/photo-1571407970349-bc81e7e96d47?w=300' },
    { name: 'Farm House', price: 189, isVeg: true, category: 'Pizzas', description: 'Loaded veggie pizza with corn & mushroom', image: 'https://images.unsplash.com/photo-1565299507177-b0ac66763828?w=300' },
    { name: 'Garlic Bread', price: 79, isVeg: true, category: 'Sides', isUnder99: true, isBestseller: true, description: 'Toasted garlic butter bread sticks', image: 'https://images.unsplash.com/photo-1573140247632-f8fd74997d5c?w=300' },
    { name: 'Pasta Arrabbiata', price: 149, isVeg: true, category: 'Pasta', description: 'Penne pasta in spicy tomato sauce', image: 'https://images.unsplash.com/photo-1555949258-eb67b1ef0ceb?w=300' },
    { name: 'Cold Coffee', price: 79, isVeg: true, category: 'Beverages', isUnder99: true, description: 'Blended iced coffee with cream', image: 'https://images.unsplash.com/photo-1517701550927-30cf4ba1dba5?w=300' },
  ],
  // Index 4 — Momos Hut
  [
    { name: 'Veg Steamed Momos (8 pcs)', price: 70, isVeg: true, category: 'Momos', isUnder99: true, isBestseller: true, description: 'Soft steamed momos with mixed veg filling', image: 'https://images.unsplash.com/photo-1625398407796-82650a8c135f?w=300' },
    { name: 'Chicken Steamed Momos (8 pcs)', price: 90, isVeg: false, category: 'Momos', isBestseller: true, isUnder99: true, description: 'Juicy chicken momos steamed to perfection', image: 'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb?w=300' },
    { name: 'Fried Momos (6 pcs)', price: 80, isVeg: true, category: 'Momos', isUnder99: true, description: 'Crispy golden fried momos', image: 'https://images.unsplash.com/photo-1625398407796-82650a8c135f?w=300' },
    { name: 'Paneer Momos (8 pcs)', price: 95, isVeg: true, category: 'Momos', isUnder99: true, description: 'Paneer and herb filled steamed momos', image: 'https://images.unsplash.com/photo-1625398407796-82650a8c135f?w=300' },
    { name: 'Chilli Chicken', price: 130, isVeg: false, category: 'Starters', isBestseller: true, description: 'Indo-Chinese crispy chilli chicken', image: 'https://images.unsplash.com/photo-1603133872878-684f208fb84b?w=300' },
    { name: 'Veg Noodles', price: 89, isVeg: true, category: 'Noodles', isUnder99: true, description: 'Hakka noodles with stir-fried veggies', image: 'https://images.unsplash.com/photo-1557872943-16a5ac26437e?w=300' },
    { name: 'Schezwan Sauce (extra)', price: 10, isVeg: true, category: 'Add-ons', isUnder99: true, description: 'Extra spicy schezwan dipping sauce', image: 'https://images.unsplash.com/photo-1455619452474-d2be8b1e70cd?w=300' },
  ],
];

const seed = async () => {
  try {
    await connectDB();

    // Clear existing data
    await Restaurant.deleteMany({});
    await MenuItem.deleteMany({});
    console.log('🗑️  Cleared existing restaurants and menu items');

    // FIX: Manually generate the slugs before bulk inserting
    const mappedRestaurants = restaurants.map(r => ({
      ...r,
      slug: r.name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '')
    }));

    // Insert restaurants with the newly generated slugs
    const createdRestaurants = await Restaurant.insertMany(mappedRestaurants);
    console.log(`✅ Inserted ${createdRestaurants.length} restaurants`);

    // Build menu items with correct restaurant references
    const allMenuItems = [];
    createdRestaurants.forEach((restaurant, i) => {
      const items = menuData[i] || [];
      items.forEach(item => {
        allMenuItems.push({ ...item, restaurant: restaurant._id });
      });
    });

    await MenuItem.insertMany(allMenuItems);
    console.log(`✅ Inserted ${allMenuItems.length} menu items`);
        // Summary
    console.log('\n📊 Seed Summary:');
    createdRestaurants.forEach((r, i) => {
      console.log(`   ${r.name} → ${menuData[i] ? menuData[i].length : 0} items`);
    });

    console.log('\n🎉 Database seeded successfully! Run: npm run dev');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seeder error:', err.message);
    process.exit(1);
  }
};

seed();

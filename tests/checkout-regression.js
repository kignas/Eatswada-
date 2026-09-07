'use strict';
const assert = require('node:assert/strict');
const { normalizeRestaurantNotes, resolveRestaurantNote } = require('../backend/services/checkoutMath');
// This standalone copy is only for note-routing logic; production checkoutMath is unchanged.
const a='507f1f77bcf86cd799439011', b='507f1f77bcf86cd799439012';
const valid=id=>/^[a-f0-9]{24}$/.test(id);
const notes=normalizeRestaurantNotes({[a]:'Less spicy',[b]:'Extra chutney'},valid);
assert.equal(resolveRestaurantNote({restaurantId:a,perRestaurantNotes:notes,flatNote:'shared',isSingleRestaurant:false,globalNote:false}),'Less spicy');
assert.equal(resolveRestaurantNote({restaurantId:b,perRestaurantNotes:notes,flatNote:'shared',isSingleRestaurant:false,globalNote:false}),'Extra chutney');
assert.equal(resolveRestaurantNote({restaurantId:'507f1f77bcf86cd799439013',perRestaurantNotes:notes,flatNote:'shared',isSingleRestaurant:false,globalNote:false}),'');
console.log('Restaurant-note routing: PASS');

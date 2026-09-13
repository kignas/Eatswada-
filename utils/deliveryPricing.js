'use strict';

// Legacy compatibility wrapper. Keep this module aligned with the canonical
// service so older imports cannot silently reintroduce the old 10–15/15+ tiers.
const { DELIVERY_RULES, MAX_DELIVERY_RADIUS_KM, calculateDeliveryFee } = require('../services/deliveryPricing');

module.exports = { DELIVERY_RULES, MAX_DELIVERY_RADIUS_KM, calculateDeliveryFee };

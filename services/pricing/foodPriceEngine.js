'use strict';

// ─────────────────────────────────────────────────────────────────────
// Food-price engine — the customer-funded online food-price uplift.
//
// Model:
//   restaurant base menu amount  = what the restaurant is contractually owed
//   online (customer) food price = base + uplift
//   Eatswada food-price revenue  = the uplift (gross price-difference revenue)
//
// There is NO conventional restaurant commission on top: the uplift IS the
// platform's food-price revenue, and counting it twice (as both markup and
// commission) is exactly the double-count this engine exists to prevent.
//
// All arithmetic is integer paise.
// ─────────────────────────────────────────────────────────────────────

const { toPaise, fromPaise, percentOfPaise } = require('./money');

/**
 * Split a restaurant's verified base food subtotal into the customer-facing
 * food price, the platform uplift and the restaurant payable amount.
 *
 * @param {object} args
 * @param {number} args.baseSubtotalRupees  server-verified restaurant menu amount
 * @param {number} args.upliftPercent       admin-configured uplift (e.g. 30)
 * @param {number} [args.restaurantChargePercent] separate contractual charge (0 = none)
 * @param {number} [args.discountRupees]    customer-facing discount applied to the food price
 * @param {boolean} [args.commissionable]   when true, a legacy commission model is used
 *                                          and the uplift is NOT charged (prevents double-count)
 * @returns {object} every amount in integer paise
 */
function computeFoodPrice({
  baseSubtotalRupees = 0,
  upliftPercent = 0,
  restaurantChargePercent = 0,
  discountRupees = 0,
  commissionable = false,
  pricesIncludeUplift = false,
} = {}) {
  // When menu prices are STORED already marked up (Eatswada price = original x
  // 1.30), the item subtotal IS the customer food price. The restaurant's
  // original price is derived back (stored / (1 + uplift)) and the uplift is
  // never charged a second time.
  const storedPaise = Math.max(0, toPaise(baseSubtotalRupees));
  const includeUplift = pricesIncludeUplift === true && !commissionable;
  const upliftFraction = Math.max(0, Number(upliftPercent) || 0) / 100;
  const basePaise = includeUplift
    ? Math.max(0, Math.round(storedPaise / (1 + upliftFraction)))
    : storedPaise;
  const discountPaise = Math.min(basePaise, Math.max(0, toPaise(discountRupees)));

  // Uplift is charged on the base menu amount (before discount). A legacy
  // commission-model restaurant keeps commission and gets no uplift, so the
  // same revenue is never counted as both commission and markup.
  const upliftPaise = commissionable ? 0
    : includeUplift ? Math.max(0, storedPaise - basePaise)
      : Math.max(0, percentOfPaise(basePaise, upliftPercent));
  const restaurantChargePaise = Math.max(0, percentOfPaise(basePaise, restaurantChargePercent));

  const grossFoodPricePaise = basePaise + upliftPaise + restaurantChargePaise;
  const customerFoodSubtotalPaise = Math.max(0, grossFoodPricePaise - discountPaise);

  // The restaurant is always owed its agreed base amount minus any
  // restaurant-funded part of the discount (allocated by the caller).
  const restaurantPayablePaise = basePaise;

  return {
    baseSubtotalPaise: basePaise,
    upliftPaise,
    restaurantChargePaise,
    discountPaise,
    grossFoodPricePaise,
    customerFoodSubtotalPaise,
    restaurantPayablePaise,
    // Convenience rupee views for API/reporting boundaries only.
    baseSubtotalRupees: fromPaise(basePaise),
    upliftRupees: fromPaise(upliftPaise),
    customerFoodSubtotalRupees: fromPaise(customerFoodSubtotalPaise),
    restaurantPayableRupees: fromPaise(restaurantPayablePaise),
  };
}

module.exports = { computeFoodPrice };

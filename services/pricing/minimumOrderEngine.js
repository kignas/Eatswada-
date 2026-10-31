'use strict';

// ─────────────────────────────────────────────────────────────────────
// Minimum-order engine (distance-aware).
//
// The ENGINE minimum is the smallest customer food basket (listing price, i.e.
// the stored menu price that already includes the Eatswada uplift) at which
// Eatswada still keeps its configured minimum contribution AFTER paying the
// restaurant its original price, the rider payout for that distance, GST on the
// uplift, gateway and risk allowances. It is computed with the SAME
// contribution model the checkout uses, at the full (unsubsidised) delivery fee,
// so a farther customer (higher rider payout) gets a higher minimum.
//
// The restaurant's own contractual minimum (Restaurant.minOrder) is a separate
// business constraint: it is never silently lowered. The effective minimum is
// the higher of the two.
//
// Contribution targets step up with basket size, so the contribution test is
// not strictly monotonic. The result is therefore "one rupee above the LAST
// basket (up to the scan cap) that fails", so every basket at or above the
// published minimum is profitable.
//
// All arithmetic is integer paise.
// ─────────────────────────────────────────────────────────────────────

const { toPaise, fromPaise, percentOfPaise } = require('./money');
const { computeContribution } = require('./profitabilityEngine');

const SCAN_CAP_RUPEES = 5000;

function computeMinimumOrder({
  rules = {},
  deliveryFeePaise = 0,
  riderPayoutPaise = 0,
  restaurantMinOrderRupees = 0,
  commissionable = false,
  commissionRate = 0,
} = {}) {
  const upliftFraction = Math.max(0, Number(rules.foodPriceUpliftPercent) || 0) / 100;
  const includesUplift = rules.menuPricesIncludeUplift !== false;
  const engineEnabled = rules.minimumOrderEnabled !== false;

  const restaurantMinimumPaise = Math.max(0, toPaise(restaurantMinOrderRupees));

  let engineMinimumPaise = 0;
  let reachable = true;
  if (engineEnabled) {
    let lastFailRupee = 0;
    for (let rupee = 1; rupee <= SCAN_CAP_RUPEES; rupee += 1) {
      const gross = rupee * 100;
      const basePaise = commissionable
        ? gross
        : includesUplift
          ? Math.max(0, Math.round(gross / (1 + upliftFraction)))
          : gross;
      const customerFood = includesUplift || commissionable
        ? gross
        : gross + percentOfPaise(gross, rules.foodPriceUpliftPercent);
      const upliftPaise = commissionable ? 0 : Math.max(0, customerFood - basePaise);
      const commissionPaise = commissionable ? percentOfPaise(basePaise, commissionRate) : 0;
      const c = computeContribution({
        baseSubtotalPaise: basePaise,
        upliftPaise,
        commissionPaise,
        customerFoodSubtotalPaise: customerFood,
        deliveryFeePaise,
        restaurantPayablePaise: Math.max(0, basePaise - commissionPaise),
        riderPayoutPaise,
        platformFundedDiscountPaise: 0,
        isCod: false,
        rules,
      });
      if (!c.meetsTarget) lastFailRupee = rupee;
    }
    if (lastFailRupee >= SCAN_CAP_RUPEES) reachable = false;
    else engineMinimumPaise = (lastFailRupee + 1) * 100;
  }

  const minimumPaise = Math.max(engineMinimumPaise, restaurantMinimumPaise);
  const source = minimumPaise === 0 ? 'none'
    : restaurantMinimumPaise >= engineMinimumPaise ? 'restaurant' : 'distance';

  return {
    reachable,
    engineMinimumPaise,
    restaurantMinimumPaise,
    minimumPaise,
    source,
    engineMinimumRupees: fromPaise(engineMinimumPaise),
    restaurantMinimumRupees: fromPaise(restaurantMinimumPaise),
    minimumRupees: fromPaise(minimumPaise),
  };
}

/** Customer-safe view: no contribution data, only what the UI shows. */
function minimumOrderView(result, currentSubtotalPaise = 0) {
  const current = Math.max(0, Number(currentSubtotalPaise) || 0);
  const minimum = result.minimumPaise;
  const remaining = Math.max(0, minimum - current);
  return {
    amount: fromPaise(minimum),
    amountRemaining: fromPaise(remaining),
    met: remaining === 0,
    source: result.source,
    message: minimum > 0
      ? (remaining > 0
        ? `Minimum order for your location is ₹${Math.ceil(fromPaise(minimum))}. Add ₹${Math.ceil(fromPaise(remaining))} more to continue.`
        : null)
      : null,
  };
}

module.exports = { computeMinimumOrder, minimumOrderView };

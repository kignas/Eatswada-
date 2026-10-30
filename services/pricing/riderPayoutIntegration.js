'use strict';

// ─────────────────────────────────────────────────────────────────────
// Rider payout integration for the dynamic pricing engine.
//
// Two responsibilities, both opt-in and both no-ops on a legacy order:
//
//  1. ensureGuaranteedPayout(order, rider)
//     Called at ASSIGNMENT time. When the order was priced by the engine it
//     guarantees the rider the projected payout (never a reduced one) and
//     records the split, so the rider app can show the guaranteed amount
//     BEFORE accepting the assignment.
//
//  2. recordDeliveryActuals(order)
//     Called at DELIVERY time. Writes the actual payout/expenses back into the
//     immutable financial snapshot (the projected block is never rewritten)
//     and returns the actual contribution for reporting.
//
// Neither function may throw into the caller's critical path: a failure is
// logged and the legacy behaviour stands.
// ─────────────────────────────────────────────────────────────────────

const { computeVehicleExpenses } = require('./riderPayoutEngine');
const { roundHalfUp } = require('./money');

/** True when this order carries an engine financial snapshot pointer. */
function isEnginePriced(order) {
  return Boolean(order?.financialSnapshot?.snapshotId);
}

/**
 * Guarantee the rider payout at assignment. Returns the effective payout in
 * rupees (never less than what the order already promises).
 */
async function ensureGuaranteedPayout(order, rider = null) {
  try {
    if (!order || !isEnginePriced(order)) return null;
    const OrderFinancialSnapshot = require('../../models/OrderFinancialSnapshot');
    const snap = await OrderFinancialSnapshot.findOne({ order: order._id }).lean();
    if (!snap) return null;

    const projectedPaise = Number(snap.projected?.riderGuaranteedPayoutPaise || 0);
    const existingPaise = Math.round(Number(order.riderEarning || 0) * 100);
    // Never reduce an accepted payout; only raise it to the guarantee.
    const effectivePaise = Math.max(projectedPaise, existingPaise);

    if (effectivePaise > existingPaise) {
      await order.constructor.updateOne(
        { _id: order._id },
        { $set: { riderEarning: effectivePaise / 100 } }
      );
      order.riderEarning = effectivePaise / 100;
    }
    return {
      guaranteedPayoutRupees: effectivePaise / 100,
      breakdown: {
        pickup: (Number(snap.projected?.riderPickupPaise || 0)) / 100,
        delivery: (Number(snap.projected?.riderDeliveryPaise || 0)) / 100,
        repositioning: (Number(snap.projected?.riderRepositionPaise || 0)) / 100,
        waiting: (Number(snap.projected?.riderWaitPaise || 0)) / 100,
        peak: (Number(snap.projected?.riderPeakPaise || 0)) / 100,
      },
      trip: snap.route || {},
      estimatedVehicleExpensesRupees: Number(snap.projected?.estimatedRiderVehicleExpensesPaise || 0) / 100,
      rider: rider ? { _id: rider._id, name: rider.name } : null,
    };
  } catch (err) {
    console.error('[pricing] guaranteed payout failed:', err.message);
    return null;
  }
}

/**
 * Record ACTUAL post-delivery figures into the snapshot. Idempotent.
 * @returns {Promise<object|null>} the updated snapshot
 */
async function recordDeliveryActuals(order, { actualPaymentProcessingPaise = null } = {}) {
  try {
    if (!order || !isEnginePriced(order)) return null;
    const { recordActuals } = require('./quoteService');
    const OrderFinancialSnapshot = require('../../models/OrderFinancialSnapshot');
    const snap = await OrderFinancialSnapshot.findOne({ order: order._id }).lean();
    if (!snap) return null;

    const actualRiderPaise = Math.round(Number(order.riderEarning || 0) * 100);
    const breakdown = order.riderEarningBreakdown || {};
    // Actual vehicle expenses use the ACTUAL trip distances when the rider app
    // reported them, else the projected ones.
    const tripKm = Number(snap.route?.totalTripKm || 0);
    const expenses = computeVehicleExpenses({
      totalKm: tripKm,
      petrolPricePerLitre: snap.rules?.petrolPricePerLitre,
      mileageKmPerLitre: snap.rules?.motorcycleMileageKmPerLitre,
      maintenanceCostPerKm: snap.rules?.maintenanceCostPerKm,
    });

    const p = snap.projected || {};
    const refundPaise = Math.round(Number(order.refund?.amount || 0) * 100)
      + Math.round(Number(order.supportRefund?.amount || 0) * 100);
    const actualGateway = Number.isFinite(Number(actualPaymentProcessingPaise))
      ? Math.round(Number(actualPaymentProcessingPaise))
      : Number(p.paymentProcessingExpensesPaise || 0);

    // Actual contribution = projected contribution, restated with the ACTUAL
    // rider payout, gateway cost, vehicle expenses and refunds.
    const actualContributionPaise = Number(p.expectedContributionPaise || 0)
      + (Number(p.riderGuaranteedPayoutPaise || 0) - actualRiderPaise)
      + (Number(p.paymentProcessingExpensesPaise || 0) - actualGateway)
      - refundPaise;

    const updated = await recordActuals(order._id, {
      actualRiderPayoutPaise: actualRiderPaise,
      actualPaymentProcessingExpensesPaise: actualGateway,
      actualRiderVehicleExpensesPaise: expenses.totalExpensesPaise,
      actualContributionPaise,
      refundPaise,
      notes: `Delivered. Rider split base=${roundHalfUp(Number(breakdown.basePay || 0) * 100)}p distance=${roundHalfUp(Number(breakdown.distancePay || 0) * 100)}p.`,
    });
    return updated;
  } catch (err) {
    console.error('[pricing] delivery actuals failed:', err.message);
    return null;
  }
}

module.exports = {
  isEnginePriced,
  ensureGuaranteedPayout,
  recordDeliveryActuals,
};

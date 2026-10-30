'use strict';

// ─────────────────────────────────────────────────────────────────────
// Small-order fee engine.
//
// Charges only the amount actually needed to close the gap to the minimum
// contribution target, capped at the admin maximum. It never charges the full
// cap by default and never charges anything when the order is already above
// target.
//
// The caller passes the current shortfall (target - contribution). The engine
// returns a fee in [0, max]. Whether that fee closes the gap is reported back
// so the orchestrator can move to the next pricing option when it cannot.
// ─────────────────────────────────────────────────────────────────────

const { toPaise, fromPaise, clampPaise } = require('./money');

/**
 * @param {object} args
 * @param {number} args.shortfallPaise  how much contribution is still missing
 * @param {number} args.maxFeePaise     admin-configured cap
 * @param {boolean} [args.enabled]
 * @returns {{feePaise:number,feeRupees:number,closesGap:boolean,remainingShortfallPaise:number}}
 */
function computeSmallOrderFee({ shortfallPaise = 0, maxFeePaise = 0, enabled = true } = {}) {
  const shortfall = Math.max(0, Number(shortfallPaise) || 0);
  const maxFee = Math.max(0, Number(maxFeePaise) || 0);

  if (!enabled || shortfall <= 0 || maxFee <= 0) {
    return {
      feePaise: 0,
      feeRupees: 0,
      closesGap: shortfall <= 0,
      remainingShortfallPaise: shortfall,
    };
  }

  const feePaise = clampPaise(shortfall, 0, maxFee);
  return {
    feePaise,
    feeRupees: fromPaise(feePaise),
    closesGap: feePaise >= shortfall,
    remainingShortfallPaise: Math.max(0, shortfall - feePaise),
  };
}

module.exports = { computeSmallOrderFee, toPaise };

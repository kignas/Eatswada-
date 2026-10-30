'use strict';

// ─────────────────────────────────────────────────────────────────────
// COD handling-fee engine.
//
// Cash orders carry real operational costs a prepaid order does not: cash
// collection and reconciliation, a higher failed-delivery risk, and the
// rider's cash-holding exposure. The fee models those costs and is applied
// ONLY to COD orders — a prepaid UPI order never pays it.
//
// The fee is a disclosed, configured percentage (with an optional fixed part)
// of the collectable cash, capped by the admin maximum. It is not a penalty:
// there is no arbitrary amount and no behavioural surcharge.
// ─────────────────────────────────────────────────────────────────────

const { toPaise, fromPaise, percentOfPaise } = require('./money');

/**
 * @param {object} args
 * @param {boolean} args.isCod          true only for cash-on-delivery orders
 * @param {number}  args.cashBaseRupees the amount collected in cash at the door
 * @param {number}  args.percent        configured percentage
 * @param {number}  [args.fixedRupees]  configured fixed part
 * @param {number}  args.maxRupees      configured cap
 * @param {boolean} [args.enabled]
 * @returns {{feePaise:number,feeRupees:number,applied:boolean}}
 */
function computeCodFee({
  isCod = false,
  cashBaseRupees = 0,
  percent = 0,
  fixedRupees = 0,
  maxRupees = 0,
  enabled = true,
} = {}) {
  if (!isCod || !enabled) {
    return { feePaise: 0, feeRupees: 0, applied: false };
  }

  const basePaise = Math.max(0, toPaise(cashBaseRupees));
  const variablePaise = Math.max(0, percentOfPaise(basePaise, percent));
  const fixedPaise = Math.max(0, toPaise(fixedRupees));
  const capPaise = Math.max(0, toPaise(maxRupees));

  const raw = variablePaise + fixedPaise;
  const feePaise = Math.min(raw, capPaise);

  return {
    feePaise,
    feeRupees: fromPaise(feePaise),
    applied: feePaise > 0,
    capped: feePaise < raw,
  };
}

module.exports = { computeCodFee };

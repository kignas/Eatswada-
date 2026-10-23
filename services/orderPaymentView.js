'use strict';

// ─────────────────────────────────────────────────────────────────────
// Payment view serializer (Pillar 3).
//
// The rider and restaurant apps must see exactly how much cash to collect and
// how much was already paid online, without re-deriving it from raw fields and
// risking a double-charge or a wrong balance. This one function is the single
// source of truth for that breakdown, so every app shows the same numbers.
//
// Example: a ₹1,000 food order with a ₹100 online advance →
//   advancePaidOnline: 100, cashToCollect: 900 (plus any fees/tip in the total).
// ─────────────────────────────────────────────────────────────────────

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

// Matches the platform registry default (platformSettingsService.codDisplayLabel);
// callers that have the live settings can override it.
const DEFAULT_COD_LABEL = 'Cash on Delivery — Free';

/**
 * Build the normalized payment view for an order document (lean or hydrated).
 *
 * @returns {{
 *   method: 'cod'|'upi',
 *   isCod: boolean,
 *   isPartialCod: boolean,
 *   paymentStatus: string,
 *   orderTotal: number,
 *   advanceRequired: number,
 *   advancePaid: number,
 *   advanceStatus: string,
 *   cashToCollect: number,
 *   cashCollected: boolean,
 *   cashCollectedAt: Date|null,
 *   label: string,
 *   blocksDelivery: boolean,
 *   blockReason: string
 * }}
 */
function buildPaymentView(order, options = {}) {
  if (!order) return null;
  const codLabel = String(options.codDisplayLabel || DEFAULT_COD_LABEL);
  const method = String(order.paymentMethod || 'upi').toLowerCase() === 'cod' ? 'cod' : 'upi';
  const isCod = method === 'cod';
  const orderTotal = money(order.total ?? order.grandTotal ?? 0);

  if (!isCod) {
    const paid = order.paymentStatus === 'paid';
    return {
      method,
      isCod: false,
      isPartialCod: false,
      paymentStatus: order.paymentStatus || 'pending',
      orderTotal,
      advanceRequired: 0,
      advancePaid: paid ? orderTotal : 0,
      advanceStatus: 'not_required',
      cashToCollect: 0,
      cashCollected: false,
      cashCollectedAt: null,
      label: 'Paid online',
      blocksDelivery: !paid,
      blockReason: paid ? '' : 'Online payment has not been captured yet.',
    };
  }

  const advanceRequired = money(order.partialCodAdvanceAmount || 0);
  const isPartialCod = advanceRequired > 0;
  const advanceStatus = order.partialCodAdvanceStatus || (isPartialCod ? 'pending' : 'not_required');
  const advancePaid = advanceStatus === 'paid' ? advanceRequired : 0;
  const cashDue = money(order.partialCodCashDue ?? Math.max(0, orderTotal - advanceRequired));
  // Cash to collect is the frozen cash-due when present, else the full total.
  const cashToCollect = isPartialCod
    ? cashDue
    : money(order.cashCollected ? (order.codCashCollectedAmount || 0) : orderTotal);

  const cashCollected = order.cashCollected === true;
  const advanceUnpaid = isPartialCod && advanceStatus !== 'paid';

  return {
    method,
    isCod: true,
    isPartialCod,
    paymentStatus: order.paymentStatus || 'cod_pending',
    orderTotal,
    advanceRequired,
    advancePaid,
    advanceStatus,
    cashToCollect: cashCollected ? 0 : cashToCollect,
    cashCollected,
    cashCollectedAt: order.codCollectedAt || null,
    // Never report "₹0 paid online" while the advance is still owed — that
    // reads as if nothing was required. State the amount due instead.
    label: isPartialCod
      ? (advanceUnpaid
        ? `₹${advanceRequired} advance due online · then ₹${cashDue} cash on delivery`
        : `₹${advancePaid} paid online · collect ₹${cashDue} cash`)
      : codLabel,
    // Delivery is blocked until a required advance is confirmed paid.
    blocksDelivery: advanceUnpaid,
    blockReason: advanceUnpaid ? 'The customer advance has not been paid; delivery cannot proceed.' : '',
  };
}

module.exports = { buildPaymentView, money };

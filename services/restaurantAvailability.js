'use strict';

// ─────────────────────────────────────────────────────────────────────
// Central restaurant availability classifier.
//
// Before this module, "is this restaurant available?" was answered in three
// different places with three different rules:
//   • controllers/restaurantController.getRestaurants sorted on the PERSISTED
//     `availability.isOpen` flag, which is stale for autoHours restaurants
//     because schedules are evaluated at request time and never written back;
//   • order acceptance used services/restaurantHours.operationalStatus();
//   • the admin console showed the raw stored flags.
// A restaurant closed by its weekly schedule therefore still sorted as "open".
//
// This module is now the single source of truth. It reuses
// services/restaurantHours (no schedule logic is duplicated) and layers the
// marketplace lifecycle on top so the four offline reasons are distinguishable:
//
//   inactive / unapproved / suspended  -> not customer-visible at all
//   temporarily_closed / closed_today / outside_hours -> visible but offline
//   orderable / busy                   -> can accept orders
//
// `orderable` is the only flag callers should use to decide whether a new
// order may be placed; `visible` decides whether the restaurant is listed.
// ─────────────────────────────────────────────────────────────────────

const { operationalStatus, getLocalContext, DAYS, BUSINESS_TIME_ZONE } = require('./restaurantHours');

const OFFLINE_CLASSES = Object.freeze([
  'temporarily_closed',
  'closed_today',
  'outside_hours',
  'suspended',
  'unapproved',
  'inactive',
]);

const AVAILABILITY_CLASSES = Object.freeze(['orderable', 'busy', ...OFFLINE_CLASSES, 'unknown']);

const LABELS = Object.freeze({
  orderable: 'Open',
  busy: 'Busy — accepting orders',
  temporarily_closed: 'Temporarily closed',
  closed_today: 'Closed today',
  outside_hours: 'Outside opening hours',
  suspended: 'Suspended by Eatswada',
  unapproved: 'Not approved yet',
  inactive: 'Inactive',
  unknown: 'Unavailable',
});

/**
 * Classify one restaurant's live availability.
 *
 * @param {object} restaurant  Restaurant document or lean object.
 * @param {Date}   now
 * @param {object} context     Optional pre-computed getLocalContext(now).
 * @returns {{
 *   class: string, orderable: boolean, visible: boolean,
 *   reason: string, label: string, operational: object|null,
 *   nextOpening: object|null
 * }}
 */
function classifyRestaurantAvailability(restaurant, now = new Date(), context = null) {
  if (!restaurant) {
    return { class: 'unknown', orderable: false, visible: false, reason: 'not_found', label: LABELS.unknown, operational: null, nextOpening: null };
  }

  // 1. Lifecycle gates. These are permanent-ish states, not daily toggles.
  if (restaurant.isActive === false) {
    return { class: 'inactive', orderable: false, visible: false, reason: 'inactive', label: LABELS.inactive, operational: null, nextOpening: null };
  }
  const approval = restaurant.approvalStatus;
  if (approval && approval !== 'approved') {
    const cls = approval === 'suspended' ? 'suspended' : 'unapproved';
    return { class: cls, orderable: false, visible: false, reason: `approval_${approval}`, label: LABELS[cls], operational: null, nextOpening: null };
  }

  // 2. Live schedule / manual availability. operationalStatus already resolves
  //    precedence (explicit override > weekly schedule > manual flag) and the
  //    overnight-window case in Asia/Kolkata.
  const local = context || getLocalContext(now);
  const operational = operationalStatus(restaurant, now, local);

  if (operational.open) {
    const cls = operational.status === 'busy' ? 'busy' : 'orderable';
    return {
      class: cls,
      orderable: true,
      visible: true,
      reason: '',
      label: LABELS[cls],
      operational,
      nextOpening: null,
    };
  }

  // 3. Offline, but customer-visible. Distinguish *why*.
  let cls;
  if (operational.reason === 'outside_hours') cls = 'outside_hours';
  else if (operational.status === 'closed_today' || operational.reason === 'closed_today') cls = 'closed_today';
  else cls = 'temporarily_closed';

  return {
    class: cls,
    orderable: false,
    visible: true,
    reason: operational.reason || operational.status || cls,
    label: operational.message || LABELS[cls],
    operational,
    nextOpening: operational.nextOpening || null,
  };
}

/** True only when the restaurant may accept a NEW order right now. */
function isOrderable(restaurant, now = new Date(), context = null) {
  return classifyRestaurantAvailability(restaurant, now, context).orderable;
}

/** True when the restaurant should appear in customer listings at all. */
function isCustomerVisible(restaurant) {
  return Boolean(restaurant) && restaurant.isActive !== false && (!restaurant.approvalStatus || restaurant.approvalStatus === 'approved');
}

/**
 * Attach the classified availability to a restaurant view without disturbing
 * the fields the existing customer payload already exposes.
 */
function withClassifiedAvailability(restaurant, now = new Date(), context = null) {
  const availability = classifyRestaurantAvailability(restaurant, now, context);
  return { ...restaurant, availabilityStatus: availability.class, orderable: availability.orderable, availabilityInfo: availability };
}

/**
 * Build an aggregation-pipeline expression that evaluates the SAME availability
 * rules as classifyRestaurantAvailability() but inside MongoDB.
 *
 * This is what lets the customer listing sort online-first BEFORE pagination
 * without loading every restaurant into Node. It intentionally mirrors the
 * precedence in restaurantHours.operationalStatus:
 *   explicit temporarily_closed / closed_today override
 *   → autoHours weekly schedule (incl. overnight windows)
 *   → manual isOpen
 * `busy` counts as orderable.
 *
 * Keep this in step with operationalStatus() — tests/restaurant-ranking.test.js
 * asserts that the two agree for every case.
 */
function buildAvailabilityExpr({ dayIndex, minutes } = {}) {
  const dayKeys = DAYS.map((day) => `openingHours.${day}`);
  const prevIndex = (dayIndex + 6) % 7;
  const today = dayKeys[dayIndex];
  const prev = dayKeys[prevIndex];
  const toMinutes = (expr) =>
    ({ $add: [{ $multiply: [{ $toInt: { $substrBytes: [expr, 0, 2] } }, 60] }, { $toInt: { $substrBytes: [expr, 3, 2] } }] });

  const closedByOverride = {
    $or: [
      { $eq: ['$availability.status', 'temporarily_closed'] },
      { $eq: ['$availability.status', 'closed_today'] },
      { $eq: ['$availability.closedReason', 'temporarily_closed'] },
      { $eq: ['$availability.closedReason', 'closed_today'] },
    ],
  };

  const manualOpen = { $and: [{ $ne: ['$availability.isOpen', false] }, { $ne: ['$isOpen', false] }] };
  const busy = { $eq: ['$availability.status', 'busy'] };

  // Today's window: not marked closed, valid times, and within [opens, closes).
  const todayValid = {
    $and: [
      { $ne: [`$${today}.closed`, true] },
      { $gt: [{ $strLenBytes: { $ifNull: [`$${today}.opensAt`, ''] } }, 4] },
      { $gt: [{ $strLenBytes: { $ifNull: [`$${today}.closesAt`, ''] } }, 4] },
    ],
  };
  const todayOpen = {
    $and: [
      todayValid,
      {
        $or: [
          // equal times => 24h day
          { $eq: [`$${today}.opensAt`, `$${today}.closesAt`] },
          {
            $and: [
              { $lt: [`$${today}.opensAt`, `$${today}.closesAt`] },
              { $gte: [minutes, toMinutes(`$${today}.opensAt`)] },
              { $lt: [minutes, toMinutes(`$${today}.closesAt`)] },
            ],
          },
          // overnight window that has already opened today
          {
            $and: [
              { $gt: [`$${today}.opensAt`, `$${today}.closesAt`] },
              { $gte: [minutes, toMinutes(`$${today}.opensAt`)] },
            ],
          },
        ],
      },
    ],
  };
  // Yesterday's overnight window still running past midnight.
  const prevOvernightOpen = {
    $and: [
      { $ne: [`$${prev}.closed`, true] },
      { $gt: [{ $strLenBytes: { $ifNull: [`$${prev}.opensAt`, ''] } }, 4] },
      { $gt: [{ $strLenBytes: { $ifNull: [`$${prev}.closesAt`, ''] } }, 4] },
      { $gt: [`$${prev}.opensAt`, `$${prev}.closesAt`] },
      { $lt: [minutes, toMinutes(`$${prev}.closesAt`)] },
    ],
  };

  const openByHours = { $or: [todayOpen, prevOvernightOpen] };

  return {
    $cond: [
      closedByOverride,
      false,
      {
        $cond: [
          { $eq: ['$availability.autoHours', true] },
          openByHours,
          { $or: [manualOpen, busy] },
        ],
      },
    ],
  };
}

module.exports = {
  AVAILABILITY_CLASSES,
  OFFLINE_CLASSES,
  LABELS,
  classifyRestaurantAvailability,
  buildAvailabilityExpr,
  isOrderable,
  isCustomerVisible,
  withClassifiedAvailability,
};

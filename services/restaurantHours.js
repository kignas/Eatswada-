'use strict';

// Restaurant schedules are evaluated in India Standard Time regardless of the
// host, browser, or MongoDB server timezone. This module is intentionally pure:
// it does not write per-minute open/closed flips to MongoDB or add scheduled jobs.
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const BUSINESS_TIME_ZONE = 'Asia/Kolkata';
const WEEKDAY_ABBREVIATIONS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const localPartsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function validTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function timeToMinutes(value) {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

function formatTime(value) {
  if (!validTime(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function getLocalContext(now = new Date()) {
  const parts = localPartsFormatter.formatToParts(now);
  const get = type => parts.find(part => part.type === type)?.value;
  const weekdayIndex = WEEKDAY_ABBREVIATIONS.indexOf(get('weekday'));
  return {
    dayIndex: weekdayIndex < 0 ? 0 : weekdayIndex,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

function previousDayIndex(index) {
  return (index + 6) % 7;
}

function normalizeClosedFlag(value) {
  if (typeof value === 'boolean') return { value, error: null };
  // Accept the two common HTML-form string values for backward compatibility,
  // but reject other truthy/falsy strings rather than silently closing a day.
  if (value === 'true') return { value: true, error: null };
  if (value === 'false') return { value: false, error: null };
  if (value === undefined) return { value: false, error: null };
  return { value: false, error: 'closed must be a boolean.' };
}

/**
 * Validates a partial weekly schedule and returns Mongo-safe dotted $set paths.
 * Partial updates are supported, so omitted days are left untouched. Unknown
 * weekday keys and malformed times are rejected before writing to MongoDB.
 */
function buildOpeningHoursUpdate(hours) {
  if (!hours || typeof hours !== 'object' || Array.isArray(hours)) {
    return { set: null, error: 'openingHours must be an object keyed by weekday.' };
  }

  const unknownDays = Object.keys(hours).filter(day => !DAYS.includes(day));
  if (unknownDays.length) {
    return { set: null, error: `Unknown opening-hours day: ${unknownDays[0]}.` };
  }

  const set = {};
  for (const dayName of DAYS) {
    if (!Object.prototype.hasOwnProperty.call(hours, dayName)) continue;
    const day = hours[dayName];
    if (!day || typeof day !== 'object' || Array.isArray(day)) {
      return { set: null, error: `openingHours.${dayName} must be an object.` };
    }

    const closedFlag = normalizeClosedFlag(day.closed);
    if (closedFlag.error) return { set: null, error: `${dayName}: ${closedFlag.error}` };
    set[`openingHours.${dayName}.closed`] = closedFlag.value;

    if (!closedFlag.value) {
      if (!validTime(day.opensAt) || !validTime(day.closesAt)) {
        return { set: null, error: `Invalid time for ${dayName} — use 24-hour HH:MM.` };
      }
      set[`openingHours.${dayName}.opensAt`] = day.opensAt;
      set[`openingHours.${dayName}.closesAt`] = day.closesAt;
    } else {
      // If times are supplied for a closed day, validate them too. We do not
      // require them for a closed day; previously saved times may be retained.
      if (day.opensAt != null && day.opensAt !== '' && !validTime(day.opensAt)) {
        return { set: null, error: `Invalid opening time for ${dayName} — use 24-hour HH:MM.` };
      }
      if (day.closesAt != null && day.closesAt !== '' && !validTime(day.closesAt)) {
        return { set: null, error: `Invalid closing time for ${dayName} — use 24-hour HH:MM.` };
      }
    }
  }

  if (!Object.keys(set).length) return { set: null, error: 'No opening hours provided.' };
  return { set, error: null };
}

function isOpenForDay(day, minutes) {
  if (!day || day.closed === true) return false;
  // Fail closed when automatic hours are enabled but the schedule is malformed.
  // The former behavior treated invalid/missing times as open, which could allow
  // orders outside a restaurant's configured schedule.
  if (!validTime(day.opensAt) || !validTime(day.closesAt)) return false;
  const opens = timeToMinutes(day.opensAt);
  const closes = timeToMinutes(day.closesAt);
  if (opens === closes) return true; // Explicit 24-hour day (00:00–00:00 or equal times).
  return opens < closes
    ? minutes >= opens && minutes < closes
    : minutes >= opens; // An overnight interval continues into the next day.
}

function isOpenByHours(restaurant, now = new Date(), context = null) {
  const local = context || getLocalContext(now);
  const today = restaurant?.openingHours?.[DAYS[local.dayIndex]];
  if (isOpenForDay(today, local.minutes)) return true;

  // Overnight schedules belong to the previous business day. Example: Monday
  // 18:00–02:00 is still open on Tuesday at 01:00 IST.
  const previous = restaurant?.openingHours?.[DAYS[previousDayIndex(local.dayIndex)]];
  if (!previous || previous.closed === true || !validTime(previous.opensAt) || !validTime(previous.closesAt)) return false;
  const opens = timeToMinutes(previous.opensAt);
  const closes = timeToMinutes(previous.closesAt);
  return opens > closes && local.minutes < closes;
}

function findNextOpening(restaurant, context, { skipToday = false } = {}) {
  const hours = restaurant?.openingHours || {};
  const firstOffset = skipToday ? 1 : 0;

  // At most one full week is scanned. No database reads or per-day timers are
  // needed, so this remains cheap for list pages and can be cached per response.
  for (let offset = firstOffset; offset <= 7; offset += 1) {
    const dayIndex = (context.dayIndex + offset) % 7;
    const day = hours[DAYS[dayIndex]];
    if (!day || day.closed === true || !validTime(day.opensAt) || !validTime(day.closesAt)) continue;

    const opens = timeToMinutes(day.opensAt);
    if (offset === 0 && opens <= context.minutes) continue;
    if (offset === 0 && opens === timeToMinutes(day.closesAt)) continue;

    let dayLabel;
    if (offset === 0) dayLabel = 'today';
    else if (offset === 1) dayLabel = 'tomorrow';
    else dayLabel = DAY_LABELS[dayIndex];

    const time = formatTime(day.opensAt);
    return {
      day: dayLabel,
      weekday: DAYS[dayIndex],
      time: day.opensAt,
      formattedTime: time,
      message: `Opens ${dayLabel} at ${time}`,
    };
  }
  return null;
}

function currentlyOpenSchedule(restaurant, context) {
  const today = restaurant?.openingHours?.[DAYS[context.dayIndex]];
  if (isOpenForDay(today, context.minutes)) {
    const opens = timeToMinutes(today.opensAt);
    const closes = timeToMinutes(today.closesAt);
    return {
      day: DAYS[context.dayIndex],
      closesAt: today.closesAt,
      closesAtFormatted: formatTime(today.closesAt),
      closesNextDay: opens > closes && context.minutes >= opens,
    };
  }

  const previousIndex = previousDayIndex(context.dayIndex);
  const previous = restaurant?.openingHours?.[DAYS[previousIndex]];
  if (previous && previous.closed !== true && validTime(previous.opensAt) && validTime(previous.closesAt)) {
    const opens = timeToMinutes(previous.opensAt);
    const closes = timeToMinutes(previous.closesAt);
    if (opens > closes && context.minutes < closes) {
      return {
        day: DAYS[previousIndex],
        closesAt: previous.closesAt,
        closesAtFormatted: formatTime(previous.closesAt),
        closesNextDay: false,
      };
    }
  }
  return null;
}

function operationalStatus(restaurant, now = new Date(), context = null) {
  const r = restaurant || {};
  const availability = r.availability || {};
  const manualStatus = availability.status;
  const closedReason = availability.closedReason;
  const autoHours = availability.autoHours === true;
  const local = context || getLocalContext(now);
  const forcedReason = [manualStatus, closedReason].find(value =>
    value === 'temporarily_closed' || value === 'closed_today'
  );

  if (forcedReason) {
    const nextOpening = autoHours && forcedReason === 'closed_today'
      ? findNextOpening(r, local, { skipToday: true })
      : null;
    return {
      open: false,
      status: forcedReason,
      reason: forcedReason,
      autoHours,
      nextOpening,
      closesAt: null,
      message: forcedReason === 'temporarily_closed' ? 'Temporarily closed' : 'Closed today',
    };
  }

  if (autoHours) {
    const open = isOpenByHours(r, now, local);
    if (!open) {
      const nextOpening = findNextOpening(r, local);
      return {
        open: false,
        status: 'closed_today',
        reason: 'outside_hours',
        autoHours: true,
        nextOpening,
        closesAt: null,
        message: nextOpening ? nextOpening.message : 'Closed',
      };
    }
    const current = currentlyOpenSchedule(r, local);
    const status = manualStatus === 'busy' ? 'busy' : 'open';
    return {
      open: true,
      status,
      reason: '',
      autoHours: true,
      nextOpening: null,
      closesAt: current ? { time: current.closesAt, formattedTime: current.closesAtFormatted, nextDay: current.closesNextDay } : null,
      message: status === 'busy' ? 'Busy' : 'Open',
    };
  }

  if (manualStatus === 'busy') {
    return { open: true, status: 'busy', reason: '', autoHours: false, nextOpening: null, closesAt: null, message: 'Busy' };
  }

  const open = availability.isOpen !== false && r.isOpen !== false;
  if (open) {
    return { open: true, status: 'open', reason: '', autoHours: false, nextOpening: null, closesAt: null, message: 'Open' };
  }
  return {
    open: false,
    status: 'temporarily_closed',
    reason: closedReason || 'manual_closed',
    autoHours: false,
    nextOpening: null,
    closesAt: null,
    message: 'Temporarily closed',
  };
}

/**
 * Public-API view that preserves existing fields while presenting effective
 * availability on the legacy isOpen fields too. No schedule calculation is
 * persisted to MongoDB. Raw schedule configuration remains available.
 */
function withOperationalAvailability(restaurant, now = new Date(), context = null) {
  if (!restaurant) return restaurant;
  const source = typeof restaurant.toObject === 'function'
    ? restaurant.toObject({ virtuals: true })
    : { ...restaurant };
  const availability = { ...(source.availability || {}) };
  const operational = operationalStatus(source, now, context);

  availability.isOpen = operational.open;
  availability.status = operational.status;
  if (operational.open) {
    availability.closedReason = '';
  } else if (operational.reason === 'outside_hours') {
    availability.closedReason = 'closed_today';
  } else if (operational.reason === 'manual_closed' && !availability.closedReason) {
    availability.closedReason = 'temporarily_closed';
  }

  return {
    ...source,
    isOpen: operational.open,
    availability,
    operational,
  };
}

module.exports = {
  DAYS,
  DAY_LABELS,
  BUSINESS_TIME_ZONE,
  validTime,
  formatTime,
  getLocalContext,
  buildOpeningHoursUpdate,
  isOpenByHours,
  operationalStatus,
  withOperationalAvailability,
};

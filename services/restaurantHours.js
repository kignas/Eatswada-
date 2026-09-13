'use strict';

// All restaurant operating hours are business-local. Render/server timezone
// must never affect whether a Maynaguri restaurant is considered open.
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const BUSINESS_TIME_ZONE = 'Asia/Kolkata';

function validTime(v) {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

function timeToMinutes(v) {
  return Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
}

function localParts(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);

  const get = type => parts.find(p => p.type === type)?.value;
  const weekday = get('weekday');
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  return {
    dayIndex: dayIndex < 0 ? 0 : dayIndex,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

function previousDayIndex(index) {
  return (index + 6) % 7;
}

function isOpenForDay(day, minutes) {
  if (!day || day.closed) return false;
  if (!validTime(day.opensAt) || !validTime(day.closesAt)) return true;
  const open = timeToMinutes(day.opensAt);
  const close = timeToMinutes(day.closesAt);
  if (open === close) return true; // explicit 24-hour schedule
  return open < close ? minutes >= open && minutes < close : minutes >= open;
}

function isOpenByHours(restaurant, now = new Date()) {
  const { dayIndex, minutes } = localParts(now);
  const today = restaurant?.openingHours?.[DAYS[dayIndex]];
  if (isOpenForDay(today, minutes)) return true;

  // Overnight schedules belong to the previous business day. Example:
  // Monday 18:00–02:00 remains open Tuesday at 01:00.
  const previous = restaurant?.openingHours?.[DAYS[previousDayIndex(dayIndex)]];
  if (!previous || previous.closed || !validTime(previous.opensAt) || !validTime(previous.closesAt)) return false;
  const open = timeToMinutes(previous.opensAt);
  const close = timeToMinutes(previous.closesAt);
  return open > close && minutes < close;
}

function operationalStatus(r, now = new Date()) {
  const status = r?.availability?.status;
  if (status === 'temporarily_closed' || status === 'closed_today' ||
      r?.availability?.closedReason === 'temporarily_closed' ||
      r?.availability?.closedReason === 'closed_today') {
    return { open: false, status: status || r.availability.closedReason };
  }
  if (status === 'busy') return { open: true, status: 'busy' };
  if (r?.availability?.autoHours) {
    const open = isOpenByHours(r, now);
    return { open, status: open ? 'open' : 'closed_today' };
  }
  return { open: r?.availability?.isOpen !== false && r?.isOpen !== false, status: 'open' };
}

module.exports = { DAYS, BUSINESS_TIME_ZONE, validTime, isOpenByHours, operationalStatus };

'use strict';
const assert = require('node:assert/strict');
const {
  BUSINESS_TIME_ZONE,
  validTime,
  formatTime,
  buildOpeningHoursUpdate,
  isOpenByHours,
  operationalStatus,
  withOperationalAvailability,
} = require('../services/restaurantHours');

assert.equal(BUSINESS_TIME_ZONE, 'Asia/Kolkata');
assert.equal(validTime('09:05'), true);
assert.equal(validTime('24:00'), false);
assert.equal(validTime('9:05'), false);
assert.equal(formatTime('15:00'), '3:00 PM');
assert.equal(formatTime('00:00'), '12:00 AM');

const daily = {};
for (const day of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']) {
  daily[day] = { closed: false, opensAt: '10:00', closesAt: '22:00' };
}
const restaurant = { isOpen: true, availability: { isOpen: true, status: 'open', autoHours: true }, openingHours: daily };

// 09:00 IST Saturday: before opening.
let result = operationalStatus(restaurant, new Date('2026-10-10T03:30:00Z'));
assert.equal(result.open, false);
assert.equal(result.reason, 'outside_hours');
assert.deepEqual(result.nextOpening, {
  day: 'today', weekday: 'saturday', time: '10:00', formattedTime: '10:00 AM', message: 'Opens today at 10:00 AM',
});

// 11:00 IST Saturday: open, with the current day's closing time exposed.
result = operationalStatus(restaurant, new Date('2026-10-10T05:30:00Z'));
assert.equal(result.open, true);
assert.equal(result.status, 'open');
assert.equal(result.closesAt.time, '22:00');
assert.equal(result.closesAt.formattedTime, '10:00 PM');

// 23:30 IST Saturday: closed and reopens Sunday at 10 AM.
result = operationalStatus(restaurant, new Date('2026-10-10T18:00:00Z'));
assert.equal(result.open, false);
assert.equal(result.nextOpening.day, 'tomorrow');
assert.equal(result.nextOpening.time, '10:00');

// Overnight Monday schedule remains open early Tuesday IST.
const overnight = {
  availability: { isOpen: true, status: 'open', autoHours: true },
  openingHours: {
    monday: { closed: false, opensAt: '18:00', closesAt: '02:00' },
    tuesday: { closed: true, opensAt: '10:00', closesAt: '22:00' },
  },
};
assert.equal(isOpenByHours(overnight, new Date('2026-09-14T19:30:00Z')), true);
result = operationalStatus(overnight, new Date('2026-09-14T19:30:00Z'));
assert.equal(result.open, true);
assert.equal(result.closesAt.time, '02:00');
assert.equal(result.closesAt.nextDay, false);
assert.equal(isOpenByHours(overnight, new Date('2026-09-14T21:30:00Z')), false);

// Explicit closures override a schedule that would otherwise be open.
const temporary = {
  ...restaurant,
  availability: { isOpen: false, status: 'temporarily_closed', closedReason: 'temporarily_closed', autoHours: true },
};
result = operationalStatus(temporary, new Date('2026-10-10T05:30:00Z'));
assert.equal(result.open, false);
assert.equal(result.status, 'temporarily_closed');
assert.equal(result.nextOpening, null);

const closedToday = {
  ...restaurant,
  availability: { isOpen: false, status: 'closed_today', closedReason: 'closed_today', autoHours: true },
};
result = operationalStatus(closedToday, new Date('2026-10-10T03:30:00Z'));
assert.equal(result.open, false);
assert.equal(result.nextOpening.day, 'tomorrow');

// Busy state is available only during configured operating hours with autoHours.
const busy = { ...restaurant, availability: { isOpen: true, status: 'busy', autoHours: true } };
assert.equal(operationalStatus(busy, new Date('2026-10-10T05:30:00Z')).status, 'busy');
assert.equal(operationalStatus(busy, new Date('2026-10-10T18:00:00Z')).open, false);

// Invalid schedules fail closed when automatic hours are enabled.
const invalid = {
  availability: { isOpen: true, status: 'open', autoHours: true },
  openingHours: { saturday: { closed: false, opensAt: 'not-a-time', closesAt: '22:00' } },
};
assert.equal(isOpenByHours(invalid, new Date('2026-10-10T05:30:00Z')), false);

// Schedule writes are partial, validated, and use safe dotted paths.
let update = buildOpeningHoursUpdate({ monday: { closed: false, opensAt: '11:00', closesAt: '21:00' }, sunday: { closed: true } });
assert.equal(update.error, null);
assert.equal(update.set['openingHours.monday.opensAt'], '11:00');
assert.equal(update.set['openingHours.sunday.closed'], true);
assert.equal(Object.prototype.hasOwnProperty.call(update.set, 'openingHours.tuesday.closed'), false);
assert.match(buildOpeningHoursUpdate({ monday: { closed: false, opensAt: '25:00', closesAt: '21:00' } }).error, /Invalid time/);
assert.match(buildOpeningHoursUpdate({ funday: { closed: true } }).error, /Unknown/);
assert.match(buildOpeningHoursUpdate([]).error, /object/);

// Public view adds computed fields while preserving other restaurant payload data.
const view = withOperationalAvailability({ ...restaurant, name: 'Test Restaurant' }, new Date('2026-10-10T03:30:00Z'));
assert.equal(view.name, 'Test Restaurant');
assert.equal(view.isOpen, false);
assert.equal(view.availability.isOpen, false);
assert.equal(view.operational.nextOpening.time, '10:00');
assert.equal(restaurant.availability.isOpen, true); // helper must not mutate the source.

console.log('Restaurant-hours schedule tests: PASS');

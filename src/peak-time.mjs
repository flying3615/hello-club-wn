export const PEAK_WINDOWS = Object.freeze({
  weekday: Object.freeze({ start: '17:00', end: '21:30' }),
  weekend: Object.freeze({ start: '13:00', end: '21:00' }),
});

const AUCKLAND_ZONE = 'Pacific/Auckland';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(?:[01]\d|2[0-3]):(?:00|30)$/;

function minutes(value) {
  if (!TIME.test(String(value || ''))) throw new Error('Booking time must be a 30-minute HH:MM value');
  const [hours, mins] = value.split(':').map(Number);
  return hours * 60 + mins;
}

function weekdayName(date) {
  if (!DATE.test(String(date || ''))) throw new Error('Booking date must be YYYY-MM-DD');
  return new Intl.DateTimeFormat('en-NZ', { timeZone: AUCKLAND_ZONE, weekday: 'long' })
    .format(new Date(`${date}T00:00:00Z`));
}

export function peakWindowForDate(date) {
  const weekday = weekdayName(date);
  const dayType = weekday === 'Saturday' || weekday === 'Sunday' ? 'weekend' : 'weekday';
  return { dayType, weekday, ...PEAK_WINDOWS[dayType] };
}

export function assertPeakBoundary({ date, start, end }) {
  const startMinutes = minutes(start);
  const endMinutes = minutes(end);
  if (endMinutes <= startMinutes) throw new Error('Booking range must end after it starts on the same date');
  const window = peakWindowForDate(date);
  const peakStart = minutes(window.start);
  const peakEnd = minutes(window.end);
  const crossesStart = startMinutes < peakStart && endMinutes > peakStart;
  const crossesEnd = startMinutes < peakEnd && endMinutes > peakEnd;
  if (crossesStart || crossesEnd) {
    const boundary = crossesStart ? window.start : window.end;
    const label = window.dayType === 'weekend' ? 'weekend' : 'weekday';
    throw new Error(`Booking interval crosses the ${label} peak boundary at ${boundary}; choose an interval entirely before or after peak time`);
  }
  return window;
}

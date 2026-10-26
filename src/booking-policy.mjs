const DEFAULT_COURT_ORDER = Object.freeze([
  'Court 4',
  'Court 5',
  'Court 6',
  'Court 1',
  'Court 2',
  'Court 3',
]);

function toMinutes(value) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`Invalid 24-hour time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function intervalKeys(start, end) {
  const startMinutes = toMinutes(start);
  const endMinutes = toMinutes(end);
  if (endMinutes <= startMinutes || (endMinutes - startMinutes) % 30 !== 0) {
    throw new Error(`Target interval must be positive and use 30-minute boundaries: ${start}-${end}`);
  }
  const keys = [];
  for (let cursor = startMinutes; cursor < endMinutes; cursor += 30) {
    const next = cursor + 30;
    const format = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    keys.push(`${format(cursor)}-${format(next)}`);
  }
  return keys;
}

function hasCompleteInterval(slots, target) {
  const available = new Map(
    slots.map((item) => [`${item.start}-${item.end}`, item.available === true]),
  );
  return intervalKeys(target.start, target.end).every((key) => available.get(key) === true);
}

export function chooseCourt(availability, target, courtOrder = DEFAULT_COURT_ORDER) {
  const byCourt = new Map(availability.map((item) => [item.court, item]));
  const checked = [];

  for (const court of courtOrder) {
    checked.push(court);
    const candidate = byCourt.get(court);
    if (candidate && hasCompleteInterval(candidate.slots, target)) {
      return { court, reason: 'complete_interval', checked };
    }
  }

  const error = new Error(`No complete interval available for ${target.start}-${target.end}`);
  error.checked = checked;
  throw error;
}

export function evaluatePaymentPage({ paymentRequired, allowUnpaidHold }) {
  if (!paymentRequired) return { action: 'confirm_free_booking', paid: false };
  if (allowUnpaidHold) {
    return { action: 'click_payment_cancel_then_verify_hold', paid: false };
  }
  return { action: 'stop_before_payment', paid: false };
}

export function verifyRemoteOutcome({ pendingHold = false, paid = false }) {
  if (paid) return { status: 'paid_booking_verified' };
  if (pendingHold) return { status: 'unpaid_hold_verified' };
  return { status: 'unknown' };
}

export { DEFAULT_COURT_ORDER, hasCompleteInterval };

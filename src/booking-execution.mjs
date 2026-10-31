function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function minutes(time) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(time));
  if (!match) throw new Error(`Invalid 24-hour time: ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function displayTime(time) {
  const value = minutes(time);
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  const suffix = hour >= 12 ? 'pm' : 'am';
  const twelve = hour % 12 || 12;
  return `${twelve}:${String(minute).padStart(2, '0')}${suffix}`;
}

export function formatBookingInterval(start, end) {
  assert(minutes(end) > minutes(start), 'Booking interval must end after it starts');
  return `${displayTime(start)} – ${displayTime(end)}`;
}

export function targetDateLabel(date) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(String(date)), 'Booking date must be YYYY-MM-DD');
  const [year, month, day] = date.split('-').map(Number);
  const formatterOptions = { timeZone: 'UTC' };
  const instant = new Date(Date.UTC(year, month - 1, day, 12));
  const weekday = new Intl.DateTimeFormat('en-NZ', { weekday: 'long', ...formatterOptions })
    .format(instant);
  const monthName = new Intl.DateTimeFormat('en-NZ', { month: 'long', ...formatterOptions })
    .format(instant);
  return `${weekday} ${day} ${monthName}`;
}

export function verifySelection(text, job, court) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  const required = [
    [targetDateLabel(job.date), 'date'],
    [formatBookingInterval(job.start, job.end), 'time'],
    [court, 'court'],
  ];
  for (const [needle, label] of required) {
    assert(value.includes(needle), `Selection dialog does not confirm the expected ${label}`);
  }
  return { ok: true };
}

export function verifyExactParticipantSet(actualParticipants, expectedParticipants) {
  const normalize = (name) => String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!Array.isArray(actualParticipants) || !Array.isArray(expectedParticipants)) {
    throw new Error('Final review does not expose an exact participant set');
  }
  const actual = actualParticipants.map(normalize).filter(Boolean).sort();
  const expected = expectedParticipants.map(normalize).filter(Boolean).sort();
  assert(actual.length === expected.length
    && actual.every((participant, index) => participant === expected[index]), 'Final review does not confirm the exact participant set');
  return { ok: true };
}

export function verifyFinalReview(text, job, court) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  const required = [
    [targetDateLabel(job.date), 'date'],
    [formatBookingInterval(job.start, job.end), 'time'],
    [court, 'court'],
    [job.bookingType, 'booking type'],
    ['All players are registered', 'player-registration acknowledgement'],
  ];
  for (const [needle, label] of required) {
    assert(value.includes(needle), `Final review does not confirm the expected ${label}`);
  }
  for (const participant of job.participants) {
    assert(value.includes(participant), 'Final review does not confirm every participant');
  }
  assert(!/\bvisitor\s+fee\b/i.test(value), 'Final review includes an unapproved visitor fee');
  assert(!/\bstadium\s+pass\b[^\n]*\b(inactive|expired|invalid)\b/i.test(value), 'Final review indicates an inactive Stadium Pass');
  const feeAmounts = [...value.matchAll(/\b(?:booking\s+)?fee\s*:?\s*\$\s*(\d+(?:\.\d{2})?)/gi)].map((match) => Number(match[1]));
  assert(feeAmounts.every((amount) => amount === 0), 'Final review includes an unapproved booking fee');
  return { ok: true };
}

export function classifyPostConfirm(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (value.includes('booking created')) return 'free';
  if (value.includes('pay for booking') || value.includes('continue to payment') || value.includes('payment required')) {
    return 'payment_required';
  }
  return 'unknown';
}

const PAYMENT_HOST = 'bookings.wnba.org.nz';
const ACCOUNT_PAYMENT_PATH = /^\/account\/booking\/([A-Za-z0-9][A-Za-z0-9_-]{5,63})\/?$/;

export function paymentBookingId(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error('Payment handoff URL is invalid');
  }
  if (parsed.protocol !== 'https:') throw new Error('Payment handoff must use HTTPS');
  if (parsed.hostname !== PAYMENT_HOST) throw new Error('Payment handoff is not the expected Hello Club host');
  if (parsed.search || parsed.hash) throw new Error('Payment handoff must not include query or fragment data');
  const match = ACCOUNT_PAYMENT_PATH.exec(parsed.pathname);
  if (!match) {
    throw new Error('Payment handoff is not an authenticated account payment page; refusing any payment-page action');
  }
  return match[1];
}

export function verifyPaymentPage({ url, text, job, court, bookingId = null }) {
  const parsedBookingId = paymentBookingId(url);
  if (bookingId !== null && parsedBookingId !== bookingId) {
    throw new Error('Payment page booking ID does not match the expected booking');
  }
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  const required = [
    ['Pay for booking', 'payment page heading'],
    ['You are paying for your', 'payment page purpose'],
    ['Wellington North Badminton Stadium', 'venue'],
    [targetDateLabel(job.date), 'date'],
    [displayTime(job.start), 'start time'],
    [court, 'court'],
  ];
  for (const [needle, label] of required) {
    assert(value.includes(needle), `Payment page does not confirm the expected ${label}`);
  }
  assert(!/\bbooking created\b/i.test(value), 'Payment page unexpectedly reports a completed booking');
  assert(!/\bconfirm booking\b/i.test(value), 'Payment page unexpectedly exposes a booking confirmation action');
  return { bookingId: parsedBookingId };
}

export function verifyRemoteBookingEvidence(text, job, court, paymentStatus) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  const required = [
    ['Wellington North Badminton Stadium', 'venue'],
    ['Your booking', 'your-booking record'],
    [targetDateLabel(job.date), 'date'],
    [formatBookingInterval(job.start, job.end), 'time'],
    [court, 'court'],
    [job.bookingType, 'booking type'],
    ...job.participants.map((participant) => [participant, 'participant']),
  ];
  for (const [needle, label] of required) {
    assert(value.includes(needle), `Remote read-back does not confirm the expected ${label}`);
  }
  if (paymentStatus === 'unpaid_hold') {
    assert(/booking fee.*not been paid yet/i.test(value), 'Remote read-back does not confirm unpaid status');
  } else {
    assert(paymentStatus === 'free', 'Remote read-back requires free or unpaid_hold status');
  }
  return { ok: true };
}

export function verifyRemoteBookingRecord(record, job, court, paymentStatus, expectedBookingId = null) {
  assert(record && typeof record === 'object', 'Remote calendar did not return a booking record');
  const required = [
    [record.date === job.date, 'date'],
    [record.start === job.start && record.end === job.end, 'time'],
    [record.court === court, 'court'],
    [record.bookingType === job.bookingType, 'booking type'],
    [record.paymentStatus === paymentStatus, 'payment status'],
    [expectedBookingId === null || record.id === expectedBookingId, 'booking ID'],
  ];
  for (const [matches, label] of required) assert(matches, `Remote calendar record does not confirm the expected ${label}`);
  assert(Array.isArray(record.participants), 'Remote calendar record does not confirm participants');
  const expectedParticipants = [...job.participants].map((name) => name.trim().toLowerCase()).sort();
  const actualParticipants = record.participants.map((name) => String(name).trim().toLowerCase()).sort();
  assert(actualParticipants.length === expectedParticipants.length
    && actualParticipants.every((participant, index) => participant === expectedParticipants[index]), 'Remote calendar record does not confirm the exact participant set');
  return { ok: true };
}

export function verifiedBookingRecord({ job, court, paymentStatus, verifiedAt }) {
  assert(/^Court [1-6]$/.test(String(court)), 'Verified booking needs a supported court');
  assert(['free', 'unpaid_hold'].includes(paymentStatus), 'Verified booking needs free or unpaid_hold payment status');
  assert(typeof verifiedAt === 'string' && Number.isFinite(Date.parse(verifiedAt)), 'Verified booking needs an ISO verifiedAt timestamp');
  return {
    id: job.id, date: job.date, start: job.start, end: job.end, court,
    bookingType: job.bookingType, participants: [...job.participants], paymentStatus, verifiedAt,
  };
}

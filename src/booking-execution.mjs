function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function minutes(time) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(time));
  if (!match) throw new Error(`Invalid 24-hour time: ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function displayTime(time) {
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
  return { ok: true };
}

export function classifyPostConfirm(text) {
  const value = String(text || '').toLowerCase();
  if (value.includes('booking created')) return 'free';
  if (value.includes('payment') || value.includes('pay now')) return 'payment_required';
  return 'unknown';
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

export function verifyRemoteBookingRecord(record, job, court, paymentStatus) {
  assert(record && typeof record === 'object', 'Remote calendar did not return a booking record');
  const required = [
    [record.date === job.date, 'date'],
    [record.start === job.start && record.end === job.end, 'time'],
    [record.court === court, 'court'],
    [record.bookingType === job.bookingType, 'booking type'],
    [record.paymentStatus === paymentStatus, 'payment status'],
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

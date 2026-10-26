const COURTS = new Set(['Court 1', 'Court 2', 'Court 3', 'Court 4', 'Court 5', 'Court 6']);
const ALLOWED_KEYS = new Set([
  'id', 'date', 'start', 'end', 'openAt', 'prepareAt', 'latestStart', 'bookingType',
  'participants', 'courtOrder', 'paymentPolicy', 'submit',
]);
const SECRET_LIKE = /pass(word)?|secret|token|cookie|card|cvc|credential|api.?key/i;
const TIME = /^(?:[01]\d|2[0-3]):(?:00|30)$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseInstant(value, name) {
  assert(typeof value === 'string', `${name} must be an ISO timestamp`);
  const time = Date.parse(value);
  assert(Number.isFinite(time), `${name} must be an ISO timestamp`);
  return time;
}

function halfHours(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return (hours * 60 + minutes) / 30;
}

export function validateLoopbackCdpEndpoint(value) {
  assert(typeof value === 'string', 'CDP endpoint must be a string');
  const endpoint = new URL(value);
  assert(endpoint.protocol === 'http:', 'CDP endpoint must use http');
  assert(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(endpoint.hostname), 'CDP endpoint must be loopback-only');
  assert(!endpoint.username && !endpoint.password, 'CDP endpoint must not include credentials');
  assert(endpoint.pathname === '/' && !endpoint.search && !endpoint.hash, 'CDP endpoint must not include a path, query, or fragment');
  assert(endpoint.port, 'CDP endpoint must include a port');
  return endpoint.toString().replace(/\/$/, '');
}

export function validateBookingJob(job, { mode = 'watch' } = {}) {
  assert(job && typeof job === 'object' && !Array.isArray(job), 'Job must be an object');
  for (const key of Object.keys(job)) {
    assert(!SECRET_LIKE.test(key), `Credential-like field is forbidden: ${key}`);
    assert(ALLOWED_KEYS.has(key), `Unknown job field: ${key}`);
  }
  assert(typeof job.id === 'string' && /^[a-z0-9][a-z0-9-]{2,63}$/.test(job.id), 'Job id must be lowercase letters, digits, and hyphens');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(job.date), 'date must be YYYY-MM-DD');
  const [year, month, day] = job.date.split('-').map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  assert(calendarDate.getUTCFullYear() === year && calendarDate.getUTCMonth() === month - 1 && calendarDate.getUTCDate() === day, 'date must be a real calendar date');
  assert(typeof job.start === 'string' && TIME.test(job.start), 'start must be a 30-minute HH:MM value');
  assert(typeof job.end === 'string' && TIME.test(job.end), 'end must be a 30-minute HH:MM value');
  assert(halfHours(job.end) > halfHours(job.start), 'Booking range must end after it starts on the same date');
  const openAt = parseInstant(job.openAt, 'openAt');
  const prepareAt = job.prepareAt === undefined ? undefined : parseInstant(job.prepareAt, 'prepareAt');
  const latestStart = parseInstant(job.latestStart, 'latestStart');
  if (prepareAt !== undefined) assert(prepareAt <= openAt, 'prepareAt must not be later than openAt');
  assert(latestStart >= openAt, 'latestStart must not be earlier than openAt');
  assert(job.bookingType === 'Stadium Pass - Singles', 'bookingType must be Stadium Pass - Singles');
  assert(Array.isArray(job.participants) && job.participants.length === 2, 'Singles booking requires exactly two participants');
  assert(job.participants.every((name) => typeof name === 'string' && name.trim().length > 0), 'participants must be non-empty names');
  assert(new Set(job.participants.map((name) => name.trim().toLowerCase())).size === job.participants.length, 'participants must be distinct');
  assert(Array.isArray(job.courtOrder) && job.courtOrder.length > 0, 'courtOrder must not be empty');
  assert(job.courtOrder.every((court) => COURTS.has(court)), 'courtOrder contains an unsupported court');
  assert(new Set(job.courtOrder).size === job.courtOrder.length, 'courtOrder must not contain duplicates');
  assert(job.paymentPolicy === 'cancel-on-payment', 'paymentPolicy must be cancel-on-payment');
  assert(typeof job.submit === 'boolean', 'submit must be boolean');
  if (mode === 'execute') assert(job.submit === true, 'execute mode requires submit: true');
  return job;
}

export const DEFAULT_CDP_ENDPOINT = 'http://127.0.0.1:9223';

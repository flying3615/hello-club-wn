import { createHash } from 'node:crypto';

export function normalizedParticipantSet(participants) {
  if (!Array.isArray(participants) || participants.length === 0) {
    throw new Error('Booking intent requires at least one participant');
  }
  const normalized = participants.map((name) => String(name || '').replace(/\s+/g, ' ').trim().toLowerCase());
  if (normalized.some((name) => !name) || new Set(normalized).size !== normalized.length) {
    throw new Error('Booking intent participants must be a unique normalized set');
  }
  return normalized.sort();
}

export function bookingIntent(job) {
  const intent = {
    date: job?.date,
    start: job?.start,
    end: job?.end,
    bookingType: String(job?.bookingType || '').replace(/\s+/g, ' ').trim(),
    participants: normalizedParticipantSet(job?.participants),
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(intent.date || '') || !/^\d{2}:\d{2}$/.test(intent.start || '') || !/^\d{2}:\d{2}$/.test(intent.end || '') || !intent.bookingType) {
    throw new Error('Booking intent has invalid date, time, or booking type');
  }
  return intent;
}

export function bookingIntentKey(job) {
  return createHash('sha256').update(JSON.stringify(bookingIntent(job))).digest('hex');
}

export function remoteRecordMatchesIntent(record, job) {
  const intent = bookingIntent(job);
  try {
    return record?.date === intent.date
      && record?.start === intent.start
      && record?.end === intent.end
      && String(record?.bookingType || '').replace(/\s+/g, ' ').trim() === intent.bookingType
      && JSON.stringify(normalizedParticipantSet(record?.participants)) === JSON.stringify(intent.participants);
  } catch {
    return false;
  }
}
